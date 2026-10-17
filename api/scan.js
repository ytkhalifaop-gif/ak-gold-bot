
/*
  ASMC / AK GOLD SCALPING BOT VIP
  File: api/scan.js

  Vercel Environment Variable:
  TWELVE_DATA_API_KEY = your Twelve Data API key
*/

const ALLOWED_INTERVALS = new Set(["5min", "15min", "1h"]);

const ALLOWED_ORIGINS = new Set([
  "https://ytkhalifaop-gif.github.io",
  "https://ak-gold-bot.vercel.app"
]);

function send(res, status, body) {
  return res.status(status).json(body);
}

function cors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function analyze(values, interval) {
  const candles = values
    .map(c => ({
      time: Math.floor(new Date(c.datetime.replace(" ", "T") + (c.datetime.endsWith("Z") ? "" : "Z")).getTime() / 1000),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 30) {
    throw new Error("Not enough valid candles from market-data provider.");
  }

  const last = candles[candles.length - 1];
  const decimals = last.close >= 100 ? 2 : 3;
  const round = n => Number(n.toFixed(decimals));

  // Recent confirmed swing points.
  const swings = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (
      c.high > prev.high &&
      c.high > candles[i - 2].high &&
      c.high >= next.high &&
      c.high >= candles[i + 2].high
    ) swings.push({ type: "high", price: c.high, index: i });

    if (
      c.low < prev.low &&
      c.low < candles[i - 2].low &&
      c.low <= next.low &&
      c.low <= candles[i + 2].low
    ) swings.push({ type: "low", price: c.low, index: i });
  }

  const recentSwings = swings.slice(-12);
  const highs = recentSwings.filter(s => s.type === "high");
  const lows = recentSwings.filter(s => s.type === "low");

  const swingHigh = highs.length ? highs[highs.length - 1].price : null;
  const swingLow = lows.length ? lows[lows.length - 1].price : null;

  // Detect FVG using three-candle imbalance.
  const fvgs = [];
  const start = Math.max(2, candles.length - 80);

  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];

    const body = Math.abs(b.close - b.open);
    const range = b.high - b.low;

    // Avoid marking tiny gaps after weak middle candles.
    const displacement = range > 0 && body / range >= 0.45;

    if (displacement && c.low > a.high) {
      fvgs.push({
        type: "Bullish FVG",
        low: round(a.high),
        high: round(c.low),
        from: a.time,
        to: c.time,
        index: i
      });
    }

    if (displacement && c.high < a.low) {
      fvgs.push({
        type: "Bearish FVG",
        low: round(c.high),
        high: round(a.low),
        from: a.time,
        to: c.time,
        index: i
      });
    }
  }

  // Detect a recent break of a confirmed swing.
  let structure = "Range / no confirmed break";
  let direction = null;
  let breakIndex = -1;
  let brokenLevel = null;

  const scanStart = Math.max(5, candles.length - 15);

  for (let i = scanStart; i < candles.length; i++) {
    const priorHighs = swings.filter(s => s.type === "high" && s.index < i);
    const priorLows = swings.filter(s => s.type === "low" && s.index < i);

    const sh = priorHighs.length ? priorHighs[priorHighs.length - 1] : null;
    const sl = priorLows.length ? priorLows[priorLows.length - 1] : null;
    const c = candles[i];

    if (sh && c.close > sh.price && c.close > c.open) {
      direction = "bullish";
      breakIndex = i;
      brokenLevel = sh.price;
    } else if (sl && c.close < sl.price && c.close < c.open) {
      direction = "bearish";
      breakIndex = i;
      brokenLevel = sl.price;
    }
  }

  if (direction) {
    const priorDirection = (() => {
      for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - 40); i--) {
        const beforeHigh = swings.filter(s => s.type === "high" && s.index < i);
        const beforeLow = swings.filter(s => s.type === "low" && s.index < i);
        const c = candles[i];
        if (beforeHigh.length && c.close > beforeHigh[beforeHigh.length - 1].price) return "bullish";
        if (beforeLow.length && c.close < beforeLow[beforeLow.length - 1].price) return "bearish";
      }
      return null;
    })();

    structure = priorDirection && priorDirection !== direction
      ? "CHoCH " + direction
      : "BOS " + direction;
  }

  // Order Block: last opposing candle before the displacement / structure break.
  let orderBlock = null;

  if (direction && breakIndex > 0) {
    for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - 10); i--) {
      const c = candles[i];
      const opposing = direction === "bullish"
        ? c.close < c.open
        : c.close > c.open;

      if (!opposing) continue;

      const obLow = Math.min(c.open, c.close);
      const obHigh = Math.max(c.open, c.close);

      orderBlock = {
        type: direction === "bullish" ? "Bullish Order Block" : "Bearish Order Block",
        low: round(obLow),
        high: round(obHigh),
        from: c.time,
        to: candles[candles.length - 1].time,
        index: i
      };
      break;
    }
  }

  // Only show zones that are not fully invalidated by a later close.
  const validFvgs = fvgs.filter(z => {
    const later = candles.slice(z.index + 1);
    if (z.type === "Bullish FVG") {
      return !later.some(c => c.close < z.low);
    }
    return !later.some(c => c.close > z.high);
  });

  if (orderBlock) {
    const later = candles.slice(orderBlock.index + 1);
    const invalid = direction === "bullish"
      ? later.some(c => c.close < orderBlock.low)
      : later.some(c => c.close > orderBlock.high);

    if (invalid) orderBlock = null;
  }

  // Keep recent zones so users can see them on the chart.
  const chartZones = [
    ...validFvgs.slice(-8).map(z => ({ ...z, kind: "FVG" })),
    ...(orderBlock ? [{ ...orderBlock, kind: "OB" }] : [])
  ];

  // Setup is deliberately conservative; zone detection alone is not a signal.
  let signal = "WAIT";
  let reason = "No confirmed entry. Wait for a retest and candle confirmation.";

  const lastFvg = validFvgs[validFvgs.length - 1];
  const inBullZone = lastFvg?.type === "Bullish FVG" &&
    last.close >= lastFvg.low && last.close <= lastFvg.high;
  const inBearZone = lastFvg?.type === "Bearish FVG" &&
    last.close >= lastFvg.low && last.close <= lastFvg.high;

  if (
    direction === "bullish" &&
    last.close >= last.open &&
    (inBullZone || (orderBlock && last.close >= orderBlock.low && last.close <= orderBlock.high))
  ) {
    signal = "BUY SETUP";
    reason = "Bullish structure with zone retest and candle confirmation.";
  } else if (
    direction === "bearish" &&
    last.close <= last.open &&
    (inBearZone || (orderBlock && last.close >= orderBlock.low && last.close <= orderBlock.high))
  ) {
    signal = "SELL SETUP";
    reason = "Bearish structure with zone retest and candle confirmation.";
  }

  let entry = null, stopLoss = null, takeProfit = null;
  if (signal !== "WAIT") {
    entry = round(last.close);
    const risk = Math.max(last.high - last.low, last.close * 0.0008) * 1.5;
    stopLoss = round(signal === "BUY SETUP" ? entry - risk : entry + risk);
    takeProfit = round(signal === "BUY SETUP" ? entry + risk * 2 : entry - risk * 2);
  }

  return {
    symbol: "XAU/USD",
    timeframe: interval,
    price: round(last.close),
    candleTime: new Date(last.time * 1000).toISOString(),
    candles,
    signal,
    reason,
    entry,
    stopLoss,
    takeProfit,
    riskReward: signal === "WAIT" ? null : "1:2",
    structure,
    brokenLevel: brokenLevel === null ? null : round(brokenLevel),
    swingHigh: swingHigh === null ? null : round(swingHigh),
    swingLow: swingLow === null ? null : round(swingLow),
    fvg: lastFvg ? {
      type: lastFvg.type,
      low: lastFvg.low,
      high: lastFvg.high,
      from: lastFvg.from,
      to: lastFvg.to
    } : null,
    orderBlock: orderBlock ? {
      type: orderBlock.type,
      low: orderBlock.low,
      high: orderBlock.high,
      from: orderBlock.from,
      to: orderBlock.to
    } : null,
    zones: chartZones,
    note: "Rule-based candle analysis; zones can fail. Confirm prices with your broker before trading."
  };
}

export default async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return send(res, 405, { error: "Use GET." });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return send(res, 500, {
      error: "TWELVE_DATA_API_KEY is missing in Vercel Environment Variables."
    });
  }

  const interval = String(req.query?.interval || "5min");
  if (!ALLOWED_INTERVALS.has(interval)) {
    return send(res, 400, { error: "Invalid interval. Use 5min, 15min or 1h." });
  }

  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "150");
    url.searchParams.set("apikey", apiKey);

    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    if (!upstream.ok || data.status === "error" || !Array.isArray(data.values)) {
      return send(res, 502, {
        error: data.message || "Market data unavailable. Check API quota and XAU/USD access."
      });
    }

    return send(res, 200, analyze(data.values, interval));
  } catch (error) {
    console.error("ASMC scan error:", error);
    return send(res, 500, { error: error.message || "Market scan failed." });
  }
}
