
const ALLOWED_ORIGINS = [
  "https://ytkhalifaop-gif.github.io",
  "https://ak-gold-bot.vercel.app"
];

const VALID_INTERVALS = {
  "5min": "5min",
  "15min": "15min",
  "1h": "1h"
};

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function cors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function round(value, decimals = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function candleTime(value) {
  // Twelve Data normally returns a date/time without a timezone.
  // Treat it as UTC only when the API has not provided a timezone.
  const text = String(value);
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(text)
    ? text
    : text.replace(" ", "T") + "Z";

  const timestamp = Math.floor(new Date(normalized).getTime() / 1000);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function detectSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;

      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }

  return { highs, lows };
}

function findFvgs(candles) {
  const zones = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const middle = candles[i - 1];
    const third = candles[i];

    const range = middle.high - middle.low;
    const body = Math.abs(middle.close - middle.open);

    if (range <= 0 || body / range < 0.35) continue;

    // Bullish FVG: gap between first candle high and third candle low.
    if (third.low > first.high && middle.close > middle.open) {
      zones.push({
        type: "Bullish FVG",
        low: first.high,
        high: third.low,
        from: first.time,
        to: third.time,
        direction: "BULLISH"
      });
    }

    // Bearish FVG: gap between third candle high and first candle low.
    if (third.high < first.low && middle.close < middle.open) {
      zones.push({
        type: "Bearish FVG",
        low: third.high,
        high: first.low,
        from: first.time,
        to: third.time,
        direction: "BEARISH"
      });
    }
  }

  return zones;
}

function findOrderBlock(candles, direction) {
  if (!direction || direction === "neutral") return null;

  const last = candles[candles.length - 1];
  const searchStart = Math.max(0, candles.length - 12);

  for (let i = candles.length - 2; i >= searchStart; i--) {
    const c = candles[i];

    if (direction === "bullish" && c.close < c.open) {
      return {
        type: "Bullish Order Block",
        low: c.low,
        high: c.high,
        from: c.time,
        to: last.time,
        direction: "BULLISH"
      };
    }

    if (direction === "bearish" && c.close > c.open) {
      return {
        type: "Bearish Order Block",
        low: c.low,
        high: c.high,
        from: c.time,
        to: last.time,
        direction: "BEARISH"
      };
    }
  }

  return null;
}

function analyze(candles) {
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const swings = detectSwings(candles);
  const recentHighs = swings.highs.slice(-2);
  const recentLows = swings.lows.slice(-2);

  const swingHigh = recentHighs.length
    ? recentHighs[recentHighs.length - 1].price
    : Math.max(...candles.slice(-20).map(c => c.high));

  const swingLow = recentLows.length
    ? recentLows[recentLows.length - 1].price
    : Math.min(...candles.slice(-20).map(c => c.low));

  let direction = "neutral";
  let structure = "RANGE";
  let reason = "Clear market structure confirm nahi hui.";

  if (last.close > swingHigh && previous.close <= swingHigh) {
    direction = "bullish";
    structure = "BOS BULLISH";
    reason = "Price ne recent swing high ke upar close diya.";
  } else if (last.close < swingLow && previous.close >= swingLow) {
    direction = "bearish";
    structure = "BOS BEARISH";
    reason = "Price ne recent swing low ke neeche close diya.";
  } else if (
    last.close > last.open &&
    last.close > previous.high &&
    last.close > (last.high + last.low) / 2
  ) {
    direction = "bullish";
    structure = "BULLISH MOMENTUM";
    reason = "Bullish momentum mila, lekin clear BOS confirm nahi.";
  } else if (
    last.close < last.open &&
    last.close < previous.low &&
    last.close < (last.high + last.low) / 2
  ) {
    direction = "bearish";
    structure = "BEARISH MOMENTUM";
    reason = "Bearish momentum mila, lekin clear BOS confirm nahi.";
  }

  const range = Math.max(
    last.high - last.low,
    Math.abs(last.close - previous.close),
    last.close * 0.0001
  );

  let signal = "WAIT";
  let entry = null;
  let stopLoss = null;
  let takeProfit = null;

  // Avoid producing a trade signal without a directional setup.
  if (direction === "bullish") {
    signal = "BUY";
    entry = last.close;
    stopLoss = Math.min(swingLow, last.low) - range * 0.15;

    const risk = entry - stopLoss;
    if (risk > 0) {
      takeProfit = entry + risk * 2;
    } else {
      signal = "WAIT";
      entry = stopLoss = takeProfit = null;
    }
  } else if (direction === "bearish") {
    signal = "SELL";
    entry = last.close;
    stopLoss = Math.max(swingHigh, last.high) + range * 0.15;

    const risk = stopLoss - entry;
    if (risk > 0) {
      takeProfit = entry - risk * 2;
    } else {
      signal = "WAIT";
      entry = stopLoss = takeProfit = null;
    }
  }

  const allFvgs = findFvgs(candles);

  // Keep only zones that price has not fully invalidated.
  const validFvgs = allFvgs.filter(zone => {
    if (zone.direction === "BULLISH") return last.close >= zone.low;
    return last.close <= zone.high;
  });

  const orderBlock = findOrderBlock(candles, direction);

  const zones = [
    ...validFvgs.slice(-8),
    ...(orderBlock ? [orderBlock] : [])
  ];

  return {
    symbol: "XAU/USD",
    timeframe: null,
    price: round(last.close, 3),
    candleTime: new Date(last.time * 1000).toISOString(),
    candles,
    signal,
    reason,
    entry: round(entry, 3),
    stopLoss: round(stopLoss, 3),
    takeProfit: round(takeProfit, 3),
    riskReward: signal === "WAIT" ? null : "1:2",
    structure,
    brokenLevel: direction === "bullish"
      ? round(swingHigh, 3)
      : direction === "bearish"
        ? round(swingLow, 3)
        : null,
    swingHigh: round(swingHigh, 3),
    swingLow: round(swingLow, 3),
    fvg: validFvgs.length ? validFvgs[validFvgs.length - 1] : null,
    orderBlock,
    zones,
    note: "Rule-based market analysis. Signals are not guaranteed; verify spread, volatility and risk before trading."
  };
}

module.exports = async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    sendJson(res, 403, { error: "Origin not allowed" });
    return;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: "TWELVE_DATA_API_KEY environment variable missing"
    });
    return;
  }

  const interval = VALID_INTERVALS[String(req.query.interval || "5min")];
  if (!interval) {
    sendJson(res, 400, {
      error: "Invalid interval. Use 5min, 15min, or 1h."
    });
    return;
  }

  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "150");
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url.toString());
    const result = await response.json();

    if (!response.ok || result.status === "error" || !Array.isArray(result.values)) {
      sendJson(res, 502, {
        error: result.message || result.code || "Market data provider returned an error"
      });
      return;
    }

    const candles = result.values
      .map(c => ({
        time: candleTime(c.datetime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length < 30) {
      sendJson(res, 502, {
        error: "Not enough valid candles returned by market data provider"
      });
      return;
    }

    const data = analyze(candles);
    data.timeframe = interval;

    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 500, {
      error: "Market scan failed",
      details: error.message
    });
  }
};
