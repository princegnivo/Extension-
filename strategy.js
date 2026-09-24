// window.POStrategy — logique RSI + mèche, utilisée par content.js
(function () {
  "use strict";

  const DEFAULT_STRATEGY = { rsiPeriod: 14, overbought: 70, oversold: 30, shadowPercent: 30 };
  const DEFAULT_MARTINGALE = { baseAmount: 100, multiplier: 2, maxSteps: 4, payout: 0.92 };

  function computeRSI(closes, period) {
    period = period || 14;
    const out = new Array(closes.length).fill(NaN);
    if (closes.length < period + 1) return out;

    let gains = 0, pertes = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      gains += Math.max(d, 0);
      pertes += Math.max(-d, 0);
    }
    let avgGain = gains / period;
    let avgLoss = pertes / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = Math.max(d, 0);
      const l = Math.max(-d, 0);
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  // Retourne le dernier signal (confirmé ou non) pour affichage + décision.
  function latestSignal(candles, strategy) {
    if (!candles || candles.length < strategy.rsiPeriod + 1) return null;

    const closes = candles.map((c) => c.close);
    const rsiArr = computeRSI(closes, strategy.rsiPeriod);
    const rsi = rsiArr[rsiArr.length - 1];
    if (Number.isNaN(rsi)) return null;

    const last = candles[candles.length - 1];
    const range = last.high - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const upperPct = range ? (upperWick / range) * 100 : 0;
    const lowerPct = range ? (lowerWick / range) * 100 : 0;
    const wick = { upperPct: upperPct, lowerPct: lowerPct };

    if (rsi >= strategy.overbought) {
      const ok = strategy.shadowPercent <= 0 || upperPct >= strategy.shadowPercent;
      return {
        confirmed: ok,
        direction: ok ? "PUT" : null,
        rsi: rsi,
        wick: wick,
        time: last.time,
        reason: ok ? "" : "mèche haute insuffisante (" + upperPct.toFixed(0) + "% < " + strategy.shadowPercent + "%)",
      };
    }
    if (rsi <= strategy.oversold) {
      const ok = strategy.shadowPercent <= 0 || lowerPct >= strategy.shadowPercent;
      return {
        confirmed: ok,
        direction: ok ? "CALL" : null,
        rsi: rsi,
        wick: wick,
        time: last.time,
        reason: ok ? "" : "mèche basse insuffisante (" + lowerPct.toFixed(0) + "% < " + strategy.shadowPercent + "%)",
      };
    }
    return { confirmed: false, direction: null, rsi: rsi, wick: wick, time: last.time, reason: "RSI neutre" };
  }

  window.POStrategy = {
    DEFAULT_STRATEGY: DEFAULT_STRATEGY,
    DEFAULT_MARTINGALE: DEFAULT_MARTINGALE,
    computeRSI: computeRSI,
    latestSignal: latestSignal,
  };
})();
