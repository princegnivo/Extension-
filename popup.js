// Logique du popup : charge/sauvegarde les réglages dans chrome.storage.sync
(function () {
  "use strict";

  const DEFAULTS = {
    strategy: Object.assign({}, window.POStrategy.DEFAULT_STRATEGY),
    martingale: Object.assign({}, window.POStrategy.DEFAULT_MARTINGALE),
    autoTrade: false,
    demoOnly: true,
    callSelector: "",
    putSelector: "",
    demoLabelSelector: "",
    wsEventName: "",
    wsPriceField: "price",
  };

  const RANGE_IDS = {
    strategy: ["rsiPeriod", "overbought", "oversold", "shadowPercent"],
    martingale: ["baseAmount", "multiplier", "maxSteps", "payout"],
  };
  const TEXT_IDS = ["callSelector", "putSelector", "demoLabelSelector", "wsEventName", "wsPriceField"];
  const CHECK_IDS = ["autoTrade", "demoOnly"];

  let current = JSON.parse(JSON.stringify(DEFAULTS));

  function fillUI() {
    RANGE_IDS.strategy.forEach(function (id) {
      document.getElementById(id).value = current.strategy[id];
      document.getElementById(id + "Val").textContent = current.strategy[id] + (id === "shadowPercent" ? " %" : "");
    });
    document.getElementById("baseAmount").value = current.martingale.baseAmount;
    document.getElementById("baseAmountVal").textContent = current.martingale.baseAmount + " $";
    document.getElementById("multiplier").value = current.martingale.multiplier;
    document.getElementById("multiplierVal").textContent = current.martingale.multiplier + " x";
    document.getElementById("maxSteps").value = current.martingale.maxSteps;
    document.getElementById("maxStepsVal").textContent = current.martingale.maxSteps;
    document.getElementById("payout").value = Math.round(current.martingale.payout * 100);
    document.getElementById("payoutVal").textContent = Math.round(current.martingale.payout * 100) + " %";

    TEXT_IDS.forEach(function (id) { document.getElementById(id).value = current[id] || ""; });
    CHECK_IDS.forEach(function (id) { document.getElementById(id).checked = !!current[id]; });
  }

  function readUI() {
    current.strategy.rsiPeriod = Number(document.getElementById("rsiPeriod").value);
    current.strategy.overbought = Number(document.getElementById("overbought").value);
    current.strategy.oversold = Number(document.getElementById("oversold").value);
    current.strategy.shadowPercent = Number(document.getElementById("shadowPercent").value);

    current.martingale.baseAmount = Number(document.getElementById("baseAmount").value);
    current.martingale.multiplier = Number(document.getElementById("multiplier").value);
    current.martingale.maxSteps = Number(document.getElementById("maxSteps").value);
    current.martingale.payout = Number(document.getElementById("payout").value) / 100;

    TEXT_IDS.forEach(function (id) { current[id] = document.getElementById(id).value.trim(); });
    CHECK_IDS.forEach(function (id) { current[id] = document.getElementById(id).checked; });
  }

  function updateLabels() {
    document.getElementById("rsiPeriodVal").textContent = document.getElementById("rsiPeriod").value;
    document.getElementById("overboughtVal").textContent = document.getElementById("overbought").value;
    document.getElementById("oversoldVal").textContent = document.getElementById("oversold").value;
    document.getElementById("shadowPercentVal").textContent = document.getElementById("shadowPercent").value + " %";
    document.getElementById("baseAmountVal").textContent = document.getElementById("baseAmount").value + " $";
    document.getElementById("multiplierVal").textContent = document.getElementById("multiplier").value + " x";
    document.getElementById("maxStepsVal").textContent = document.getElementById("maxSteps").value;
    document.getElementById("payoutVal").textContent = document.getElementById("payout").value + " %";
  }

  function save() {
    readUI();
    chrome.storage.sync.set({ poStrategySettings: current }, function () {
      const status = document.getElementById("status");
      status.textContent = "Enregistré";
      setTimeout(function () { status.textContent = ""; }, 1200);
    });
  }

  function load() {
    chrome.storage.sync.get("poStrategySettings", function (data) {
      if (data && data.poStrategySettings) {
        current = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), data.poStrategySettings);
        current.strategy = Object.assign({}, DEFAULTS.strategy, data.poStrategySettings.strategy);
        current.martingale = Object.assign({}, DEFAULTS.martingale, data.poStrategySettings.martingale);
      }
      fillUI();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();

    document.querySelectorAll('input[type="range"]').forEach(function (el) {
      el.addEventListener("input", updateLabels);
      el.addEventListener("change", save);
    });
    TEXT_IDS.concat(CHECK_IDS).forEach(function (id) {
      document.getElementById(id).addEventListener("change", save);
    });

    document.getElementById("reset").addEventListener("click", function () {
      current = JSON.parse(JSON.stringify(DEFAULTS));
      fillUI();
      save();
    });
  });
})();
