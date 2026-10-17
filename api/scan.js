
/*
 * AK GOLD SCALPING BOT VIP
 * File: api/scan.js
 *
 * Vercel Environment Variable:
 * TWELVE_DATA_API_KEY = your Twelve Data API key
 *
 * Supported intervals: 5min, 15min, 1h
 */

const ALLOWED_INTERVALS = new Set(["5min", "15min", "1h"]);

const ALLOWED_ORIGINS = new Set([
  "https://ytkhalifaop-gif.github.io",
  "https://ak-gold-bot.vercel.app"
]);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
}

function sendError(res, status, message) {
  return res.status(status).json({
    error: String(message || "Unknown server error")
  });
}

function round(value, decimals) {
  return Number(Number(value).toFixed(decimals));
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

function overlaps(zone, candle) {
  return candle.high >= zone.low && candle.low <= zone.high;
}

function analyzeCandles(values, interval) {
  // Normalize candles into chronological order.
  const bars = values
    .slice()
    .reverse()
    .map((c) => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: c.volume == null ? null : Number(c.volume)
    }))
    .filter((c) =>
      c.time &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close) &&
      c.high >= c.low
    );

  if (bars.length < 30) {
    throw new Error("Not enough valid candles. At least 30 are required.");
  }

  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const decimals = last.close >= 100 ? 2 : 3;

  const averageRange =
    bars.slice(-20).reduce((sum, c) => sum + c.high - c.low, 0) / 20;

  const minimumGap = Math.max(
    averageRange * 0.08,
    last.close * 0.00003
  );

  // Find confirmed swing highs/lows using two candles on each side.
  const swings = [];

  for (let i = 2; i < bars.length - 2; i++) {
    const c = bars[i];
    const left = bars.slice(i - 2, i);
    const right = bars.slice(i + 1, i + 3);

    if (
      left.every((x) => c.high > x.high) &&
      right.every((x) => c.high >= x.high)
    ) {
      swings.push({
        type: "high",
        index: i,
        price: c.high,
        time: c.time
      });
    }

    if (
      left.every((x) => c.low < x.low) &&
      right.every((x) => c.low <= x.low)
    ) {
      swings.push({
        type: "low",
        index: i,
        price: c.low,
        time: c.time
      });
    }
  }

  const recentSwings = swings.filter(
    (s) => s.index >= bars.length - 30
  );

  const highSwings = recentSwings.filter((s) => s.type === "high");
  const lowSwings = recentSwings.filter((s) => s.type === "low");
  const recentBars = bars.slice(-21, -1);

  const swingHigh = highSwings.length
    ? highSwings[highSwings.length - 1].price
    : Math.max(...recentBars.map((c) => c.high));

  const swingLow = lowSwings.length
    ? lowSwings[lowSwings.length - 1].price
    : Math.min(...recentBars.map((c) => c.low));

  // Detect three-candle Fair Value Gaps.
  const allFvgs = [];
  const fvgStart = Math.max(2, bars.length - 60);

  for (let i = fvgStart; i < bars.length; i++) {
    const first = bars[i - 2];
    const middle = bars[i - 1];
    const third = bars[i];

    const middleBody = Math.abs(middle.close - middle.open);
    const displacementOk = middleBody >= averageRange * 0.25;

    if (
      third.low - first.high >= minimumGap &&
      displacementOk
    ) {
      const zone = {
        id: `bull-fvg-${i}`,
        type: "Bullish FVG",
        direction: "bullish",
        low: first.high,
        high: third.low,
        startTime: first.time,
        formedAt: third.time,
        index: i
      };

      zone.mitigated = bars.slice(i + 1).some(
        (c) => c.low <= zone.high && c.high >= zone.low
      );

      zone.invalidated = bars.slice(i + 1).some(
        (c) => c.close < zone.low
      );

      allFvgs.push(zone);
    }

    if (
      first.low - third.high >= minimumGap &&
      displacementOk
    ) {
      const zone = {
        id: `bear-fvg-${i}`,
        type: "Bearish FVG",
        direction: "bearish",
        low: third.high,
        high: first.low,
        startTime: first.time,
        formedAt: third.time,
        index: i
      };

      zone.mitigated = bars.slice(i + 1).some(
        (c) => c.high >= zone.low && c.low <= zone.high
      );

      zone.invalidated = bars.slice(i + 1).some(
        (c) => c.close > zone.high
      );

      allFvgs.push(zone);
    }
  }

  // Detect BOS by closing beyond a previously confirmed swing.
  let structure = "No confirmed BOS";
  let direction = null;
  let breakIndex = -1;
  let brokenLevel = null;

  const bosStart = Math.max(5, bars.length - 12);

  for (let i = bosStart; i < bars.length; i++) {
    const priorHighs = swings.filter(
      (s) => s.type === "high" && s.index < i
    );

    const priorLows = swings.filter(
      (s) => s.type === "low" && s.index < i
    );

    const previousHigh = priorHighs[priorHighs.length - 1];
    const previousLow = priorLows[priorLows.length - 1];
    const candle = bars[i];

    if (
      previousHigh &&
      candle.close > previousHigh.price &&
      isBullish(candle)
    ) {
      structure = "Bullish BOS";
      direction = "bullish";
      breakIndex = i;
      brokenLevel = previousHigh.price;
    } else if (
      previousLow &&
      candle.close < previousLow.price &&
      isBearish(candle)
    ) {
      structure = "Bearish BOS";
      direction = "bearish";
      breakIndex = i;
      brokenLevel = previousLow.price;
    }
  }

  // Find the last opposing candle before a confirmed displacement BOS.
  const orderBlocks = [];

  if (breakIndex > 0 && direction) {
    const breakCandle = bars[breakIndex];
    const body = Math.abs(breakCandle.close - breakCandle.open);
    const displacementOk = body >= averageRange * 0.5;

    if (displacementOk) {
      for (
        let i = breakIndex - 1;
        i >= Math.max(0, breakIndex - 8);
        i--
      ) {
        const candle = bars[i];

        const opposing =
          direction === "bullish"
            ? isBearish(candle)
            : isBullish(candle);

        if (!opposing) continue;

        const zone =
          direction === "bullish"
            ? {
                id: `bull-ob-${i}`,
                type: "Bullish Order Block",
                direction: "bullish",
                low: candle.low,
                high: Math.max(candle.open, candle.close),
                startTime: candle.time,
                formedAt: breakCandle.time,
                index: i
              }
            : {
                id: `bear-ob-${i}`,
                type: "Bearish Order Block",
                direction: "bearish",
                low: Math.min(candle.open, candle.close),
                high: candle.high,
                startTime: candle.time,
                formedAt: breakCandle.time,
                index: i
              };

        zone.mitigated = bars
          .slice(breakIndex + 1)
          .some((c) => overlaps(zone, c));

        zone.invalidated =
          direction === "bullish"
            ? bars.slice(breakIndex + 1).some(
                (c) => c.close < zone.low
              )
            : bars.slice(breakIndex + 1).some(
                (c) => c.close > zone.high
              );

        if (!zone.invalidated) {
          orderBlocks.push(zone);
        }

        break;
      }
    }
  }

  // Remove invalidated FVGs. Keep mitigation status for chart styling.
  const fvgs = allFvgs
    .filter((z) => !z.invalidated)
    .slice(-12)
    .map((z) => ({
      id: z.id,
      type: z.type,
      direction: z.direction,
      low: round(z.low, decimals),
      high: round(z.high, decimals),
      startTime: z.startTime,
      formedAt: z.formedAt,
      mitigated: z.mitigated,
      invalidated: z.invalidated
    }));

  const cleanOrderBlocks = orderBlocks.map((z) => ({
    id: z.id,
    type: z.type,
    direction: z.direction,
    low: round(z.low, decimals),
    high: round(z.high, decimals),
    startTime: z.startTime,
    formedAt: z.formedAt,
    mitigated: z.mitigated,
    invalidated: z.invalidated
  }));

  const latestBullGap =
    [...fvgs].reverse().find(
      (z) => z.direction === "bullish" && !z.mitigated
    ) || null;

  const latestBearGap =
    [...fvgs].reverse().find(
      (z) => z.direction === "bearish" && !z.mitigated
    ) || null;

  const bullishOB =
    cleanOrderBlocks.find(
      (z) => z.direction === "bullish" && !z.mitigated
    ) || null;

  const bearishOB =
    cleanOrderBlocks.find(
      (z) => z.direction === "bearish" && !z.mitigated
    ) || null;

  const inside = (zone, price) =>
    Boolean(zone && price >= zone.low && price <= zone.high);

  const bullishZone =
    inside(latestBullGap, last.close) ||
    inside(bullishOB, last.close);

  const bearishZone =
    inside(latestBearGap, last.close) ||
    inside(bearishOB, last.close);

  // Conservative setup confirmation; otherwise remain WAIT.
  let signal = "WAIT";

  let reason =
    "No fully aligned setup. Wait for confirmed BOS, valid zone retest and candle confirmation.";

  const bullishReference = latestBullGap || bullishOB;
  const bearishReference = latestBearGap || bearishOB;

  const bullishConfirm =
    direction === "bullish" &&
    bullishZone &&
    bullishReference &&
    isBullish(last) &&
    (
      previous.low <= bullishReference.high ||
      last.low <= bullishReference.high
    );

  const bearishConfirm =
    direction === "bearish" &&
    bearishZone &&
    bearishReference &&
    isBearish(last) &&
    (
      previous.high >= bearishReference.low ||
      last.high >= bearishReference.low
    );

  if (bullishConfirm) {
    signal = "BUY SETUP";
    reason =
      "Bullish BOS, unmitigated bullish zone and bullish candle confirmation detected.";
  } else if (bearishConfirm) {
    signal = "SELL SETUP";
    reason =
      "Bearish BOS, unmitigated bearish zone and bearish candle confirmation detected.";
  }

  let entry = null;
  let stopLoss = null;
  let takeProfit = null;
  let riskReward = null;

  if (signal !== "WAIT") {
    entry = round(last.close, decimals);

    const candleRisk = Math.max(
      last.high - last.low,
      averageRange * 0.5
    );

    const risk = Math.max(
      candleRisk * 1.25,
      last.close * 0.0005
    );

    if (signal === "BUY SETUP") {
      const zone = bullishReference;

      stopLoss = round(
        Math.min(entry - risk, zone.low - averageRange * 0.1),
        decimals
      );

      takeProfit = round(
        entry + (entry - stopLoss) * 2,
        decimals
      );
    } else {
      const zone = bearishReference;

      stopLoss = round(
        Math.max(entry + risk, zone.high + averageRange * 0.1),
        decimals
      );

      takeProfit = round(
        entry - (stopLoss - entry) * 2,
        decimals
      );
    }

    riskReward = "1:2";
  }

  const latestFvg =
    direction === "bullish"
      ? latestBullGap
      : direction === "bearish"
        ? latestBearGap
        : fvgs[fvgs.length - 1] || null;

  // Include the latest 100 candles for the custom interactive chart.
  const candles = bars.slice(-100).map((c) => ({
    time: c.time,
    open: round(c.open, decimals),
    high: round(c.high, decimals),
    low: round(c.low, decimals),
    close: round(c.close, decimals),
    volume: Number.isFinite(c.volume) ? c.volume : null
  }));

  return {
    symbol: "XAU/USD",
    timeframe: interval,
    price: round(last.close, decimals),
    candleTime: last.time,
    signal,
    reason,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    structure,
    brokenLevel:
      brokenLevel == null ? null : round(brokenLevel, decimals),
    swingHigh: round(swingHigh, decimals),
    swingLow: round(swingLow, decimals),

    fvg: latestFvg
      ? {
          id: latestFvg.id,
          type: latestFvg.type,
          direction: latestFvg.direction,
          low: latestFvg.low,
          high: latestFvg.high,
          startTime: latestFvg.startTime,
          formedAt: latestFvg.formedAt,
          mitigated: latestFvg.mitigated
        }
      : null,

    orderBlock: cleanOrderBlocks[0] || null,

    // Arrays are used by the new custom chart to draw zone overlays.
    fvgs,
    orderBlocks: cleanOrderBlocks,
    candles,

    note:
      "Rule-based technical analysis only. Not separate AI confirmation or a guaranteed prediction. Verify quotes and zones with your broker before trading."
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");

    return sendError(
      res,
      405,
      "Method not allowed. Use GET or POST."
    );
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return sendError(
      res,
      500,
      "TWELVE_DATA_API_KEY missing. Add it in Vercel Environment Variables and redeploy."
    );
  }

  const params =
    req.method === "POST"
      ? req.body || {}
      : req.query || {};

  const interval = String(params.interval || "5min");

  if (!ALLOWED_INTERVALS.has(interval)) {
    return sendError(
      res,
      400,
      "Invalid interval. Use 5min, 15min, or 1h."
    );
  }

  try {
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", apiKey);

    const upstream = await fetch(url.toString());

    let data;

    try {
      data = await upstream.json();
    } catch {
      return sendError(
        res,
        502,
        "Market data provider returned an invalid response."
      );
    }

    if (
      !upstream.ok ||
      data.status === "error" ||
      !Array.isArray(data.values)
    ) {
      return sendError(
        res,
        502,
        data.message ||
          "Market data unavailable. Check the Twelve Data API key, quota and XAU/USD access."
      );
    }

    const result = analyzeCandles(data.values, interval);

    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json(result);
  } catch (error) {
    console.error("ASMC scan error:", error);

    return sendError(
      res,
      500,
      error.message || "Market analysis failed."
    );
  }
}
