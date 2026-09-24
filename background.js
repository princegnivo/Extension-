// Service worker : initialise les réglages par défaut à l'installation.
const DEFAULTS = {
  strategy: { rsiPeriod: 14, overbought: 70, oversold: 30, shadowPercent: 30 },
  martingale: { baseAmount: 100, multiplier: 2, maxSteps: 4, payout: 0.92 },
  autoTrade: false,
  demoOnly: true,
  callSelector: "",
  putSelector: "",
  demoLabelSelector: "",
  // Réglages du flux Socket.IO — à remplir via le panneau "Découverte"
  // de l'overlay une fois l'événement de prix identifié.
  wsEventName: "",
  wsPriceField: "price",
};

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.get("poStrategySettings", function (data) {
    if (!data || !data.poStrategySettings) {
      chrome.storage.sync.set({ poStrategySettings: DEFAULTS });
    }
  });
});
