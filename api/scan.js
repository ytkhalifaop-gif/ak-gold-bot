
/*
  ASMC / AK GOLD SCALPING BOT VIP
  File: api/scan.js

  Vercel Environment Variable:
  TWELVE_DATA_API_KEY = your Twelve Data API key

  Supported intervals: 5min, 15min, 1h
*/

const ALLOWED_INTERVALS = new Set(["5min", "15min", "1h"]);

function analyzeCandles(values, interval) {
  // Twelve Data candles are usually newest first.
  const bars = values
    .slice()
    .reverse()
    .map((c) => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }))
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    );

  if (bars.length < 30) {
    throw new Error("Not enough valid candles for analysis.");
  }

  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const decimals = last.close >= 100 ? 2 : 3;

  // Recent swing levels.
  const recent = bars.slice(-21, -1);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));

  // Find recent Fair Value Gaps.
  const gaps = [];

  for (let i = Math.max(2, bars.length - 30); i < bars.length; i++) {
    const first = bars[i - 2];
    const third = bars[i];

    if (third.low > first.high) {
      gaps.push({
        type: "Bullish FVG",
        low: first.high,
        high: third.low,
        index: i,
      });
    }

    if (third.high < first.low) {
      gaps.push({
        type: "Bearish FVG",
        low: third.high,
        high: first.low,
        index: i,
      });
    }
  }

  // Basic recent Break of Structure (BOS).
  let structure = "No recent BOS";
  let direction = null;
  let breakIndex = -1;

  const structureStart = Math.max(10, bars.length - 8);

  for (let i = structureStart; i < bars.length; i++) {
    const history = bars.slice(Math.max(0, i - 10), i);
    if (history.length < 5) continue;

    const priorHigh = Math.max(...history.map((c) => c.high));
    const priorLow = Math.min(...history.map((c) => c.low));
    const candle = bars[i];

    if (candle.close > priorHigh && candle.close > candle.open) {
      structure = "Bullish BOS";
      direction = "bullish";
      breakIndex = i;
    } else if (
      candle.close < priorLow &&
      candle.close < candle.open
    ) {
      structure = "Bearish BOS";
      direction = "bearish";
      breakIndex = i;
    }
  }

  // Heuristic Order Block:
  // the last opposing candle before the detected structure break.
  let orderBlock = null;

  if (breakIndex > 0 && direction === "bullish") {
    for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - 10); i--) {
      const candle = bars[i];

      if (candle.close < candle.open) {
        orderBlock = {
          type: "Bullish OB (heuristic)",
          low: candle.low,
          high: candle.open,
        };
        break;
      }
    }
  }

  if (breakIndex > 0 && direction === "bearish") {
    for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - 10); i--) {
      const candle = bars[i];

      if (candle.close > candle.open) {
        orderBlock = {
          type: "Bearish OB (heuristic)",
          low: candle.open,
          high: candle.high,
        };
        break;
      }
    }
  }

  // Latest FVG for each direction.
  const latestBullGap =
    [...gaps].reverse().find((z) => z.type === "Bullish FVG") || null;

  const latestBearGap =
    [...gaps].reverse().find((z) => z.type === "Bearish FVG") || null;

  const inside = (zone, price) =>
    Boolean(zone && price >= zone.low && price <= zone.high);

  const bullishZone =
    inside(latestBullGap, last.close) ||
    (orderBlock?.type.startsWith("Bullish") &&
      inside(orderBlock, last.close));

  const bearishZone =
    inside(latestBearGap, last.close) ||
    (orderBlock?.type.startsWith("Bearish") &&
      inside(orderBlock, last.close));

  // Signal rules: structure, relevant zone and candle confirmation.
  let signal = "WAIT";
  let reason =
    "No aligned setup. Wait for structure, zone and candle confirmation.";

  if (
    direction === "bullish" &&
    bullishZone &&
    last.close >= last.open &&
    previous.close <= previous.open
  ) {
    signal = "BUY SETUP";
    reason =
      "Bullish BOS, bullish zone and candle confirmation detected.";
  } else if (
    direction === "bearish" &&
    bearishZone &&
    last.close <= last.open &&
    previous.close >= previous.open
  ) {
    signal = "SELL SETUP";
    reason =
      "Bearish BOS, bearish zone and candle confirmation detected.";
  }

  // Entry, SL and TP only when a setup condition is met.
  let entry = null;
  let stopLoss = null;
  let takeProfit = null;
  let riskReward = null;

  if (signal !== "WAIT") {
    entry = Number(last.close.toFixed(decimals));

    const candleRisk = last.high - last.low;
    const risk = Math.max(candleRisk * 1.5, last.close * 0.0008);

    if (signal === "BUY SETUP") {
      stopLoss = Number((entry - risk).toFixed(decimals));
      takeProfit = Number((entry + risk * 2).toFixed(decimals));
    } else {
      stopLoss = Number((entry + risk).toFixed(decimals));
      takeProfit = Number((entry - risk * 2).toFixed(decimals));
    }

    riskReward = "1:2";
  }

  // Report the FVG relevant to the detected direction.
  const relevantFvg =
    direction === "bullish"
      ? latestBullGap
      : direction === "bearish"
        ? latestBearGap
        : latestBullGap || latestBearGap;

  return {
    symbol: "XAU/USD",
    timeframe: interval,
    price: Number(last.close.toFixed(decimals)),
    candleTime: last.time,
    signal,
    reason,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    structure,
    swingHigh: Number(swingHigh.toFixed(decimals)),
    swingLow: Number(swingLow.toFixed(decimals)),
    fvg: relevantFvg
      ? {
          type: relevantFvg.type,
          low: Number(relevantFvg.low.toFixed(decimals)),
          high: Number(relevantFvg.high.toFixed(decimals)),
        }
      : null,
    orderBlock: orderBlock
      ? {
          type: orderBlock.type,
          low: Number(orderBlock.low.toFixed(decimals)),
          high: Number(orderBlock.high.toFixed(decimals)),
        }
      : null,
    note:
      "Rule-based technical analysis only. This is not a separate AI confirmation or a guaranteed prediction.",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res
      .status(405)
      .json({ error: "Method not allowed. Use GET or POST." });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error:
        "TWELVE_DATA_API_KEY is missing. Add it in Vercel Environment Variables and redeploy.",
    });
  }

  const params = req.method === "POST" ? req.body || {} : req.query || {};
  const interval = String(params.interval || "5min");

  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: "Invalid interval. Use 5min, 15min, or 1h.",
    });
  }

  try {
    const url = new URL("https://api.twelvedata.com/time_series");

    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", apiKey);

    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    if (
      !upstream.ok ||
      data.status === "error" ||
      !Array.isArray(data.values)
    ) {
      return res.status(502).json({
        error:
          data.message ||
          "Market data unavailable. Check your Twelve Data API key, quota and XAU/USD symbol access.",
      });
    }

    const result = analyzeCandles(data.values, interval);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Market analysis failed.",
    });
  }
}
