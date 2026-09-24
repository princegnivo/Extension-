// Content script : agrège les ticks en bougies 5s, exécute la stratégie,
// affiche un overlay avec découverte du flux + sélecteur d'élément, et gère
// (optionnellement) l'auto-trade en compte démo.
(function () {
  "use strict";

  const CANDLE_MS = 5000;
  const MAX_CANDLES = 200;
  const MAX_DISCOVERED = 40;

  let settings = {
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

  let candles = [];
  let current = null;
  let lastSignaledCandleTime = 0;
  let mgStep = 0;
  let sessionPnL = 0;
  let wins = 0;
  let losses = 0;
  const discovered = new Map(); // event -> sample

  // 1) Injecte le hook Socket.IO
  function injectHook() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inpage.js");
    s.onload = function () { s.remove(); };
    (document.head || document.documentElement).appendChild(s);
  }

  function sendConfigToPage() {
    window.postMessage(
      { source: "PO_STRATEGY_CONFIG", config: { eventFilter: settings.wsEventName, priceField: settings.wsPriceField } },
      "*"
    );
  }

  // 2) Réception des messages du script injecté
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.source) return;

    if (msg.source === "PO_STRATEGY_TICK") {
      onTick(msg.tick.price, msg.tick.time);
    } else if (msg.source === "PO_STRATEGY_DISCOVER") {
      if (!discovered.has(msg.event)) {
        if (discovered.size >= MAX_DISCOVERED) return; // limite mémoire/affichage
        discovered.set(msg.event, msg.sample);
        renderDiscovery();
      }
    } else if (msg.source === "PO_STRATEGY_READY") {
      sendConfigToPage();
    }
  });

  function onTick(price, time) {
    const bucket = Math.floor(time / CANDLE_MS) * CANDLE_MS;
    if (!current || current.time !== bucket) {
      if (current) {
        candles.push(current);
        if (candles.length > MAX_CANDLES) candles.shift();
        onCandleClosed();
      }
      current = { time: bucket, open: price, high: price, low: price, close: price };
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
    }
    render();
  }

  function onCandleClosed() {
    const sig = window.POStrategy.latestSignal(candles, settings.strategy);
    render(sig);
    if (!sig || !sig.confirmed) return;
    if (sig.time === lastSignaledCandleTime) return;
    lastSignaledCandleTime = sig.time;

    notifySignal(sig);
    if (settings.autoTrade) tryAutoTrade(sig);
  }

  // 3) Auto-trade (compte démo uniquement par défaut)
  function isDemoAccount() {
    if (!settings.demoLabelSelector) return false;
    const el = document.querySelector(settings.demoLabelSelector);
    if (!el) return false;
    return /demo|démo|entrain|training/i.test(el.textContent || "");
  }

  function tryAutoTrade(sig) {
    if (settings.demoOnly && !isDemoAccount()) {
      flash("Auto-trade bloqué : compte non-démo (ou sélecteur non configuré)", "warn");
      return;
    }
    const amount = Number(
      (settings.martingale.baseAmount * Math.pow(settings.martingale.multiplier, mgStep)).toFixed(2)
    );
    setAmount(amount);
    const selector = sig.direction === "CALL" ? settings.callSelector : settings.putSelector;
    if (!selector) {
      flash("Sélecteur " + sig.direction + " non configuré — utilise le sélecteur d'élément", "warn");
      return;
    }
    const btn = document.querySelector(selector);
    if (!btn) {
      flash("Bouton introuvable (" + selector + ")", "warn");
      return;
    }
    btn.click();
    flash((sig.direction === "CALL" ? "▲ CALL" : "▼ PUT") + " placé — mise " + amount + "$ (palier " + mgStep + ")", "ok");
  }

  function setAmount(amount) {
    const input = document.querySelector('input[type="text"][inputmode="numeric"], .value__val input, input.amount');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, String(amount));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function reportResult(win) {
    if (win) {
      wins++;
      sessionPnL += settings.martingale.baseAmount * Math.pow(settings.martingale.multiplier, mgStep) * settings.martingale.payout;
      mgStep = 0;
    } else {
      losses++;
      sessionPnL -= settings.martingale.baseAmount * Math.pow(settings.martingale.multiplier, mgStep);
      mgStep = mgStep + 1 > settings.martingale.maxSteps ? 0 : mgStep + 1;
    }
    render();
  }

  // --- Sélecteur d'élément par clic (pas besoin de clic droit / DevTools) ---
  let picking = false;

  function guessSelector(el) {
    if (el.id) return "#" + el.id;
    if (typeof el.className === "string" && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 3).join(".");
      if (cls) return el.tagName.toLowerCase() + "." + cls;
    }
    return el.tagName.toLowerCase();
  }

  function copie(texte) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texte).catch(function () { copieFallback(texte); });
    } else {
      copieFallback(texte);
    }
  }
  function copieFallback(texte) {
    const ta = document.createElement("textarea");
    ta.value = texte;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function onPickClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    picking = false;
    root.querySelector("#pos-pick").textContent = "Choisir un élément";

    const el = e.target;
    const selector = guessSelector(el);
    const html = el.outerHTML.slice(0, 300);
    copie(selector);

    const box = root.querySelector("#pos-picked");
    box.style.display = "block";
    box.innerHTML =
      '<div class="pos-picked-sel">' + selector + " <em>(copié)</em></div>" +
      '<div class="pos-picked-html">' + html.replace(/</g, "&lt;") + "</div>";
  }

  // --- Overlay UI ---
  let root;
  function buildOverlay() {
    root = document.createElement("div");
    root.id = "po-strategy-overlay";
    root.innerHTML =
      '<div class="pos-head"><span class="pos-dot"></span><strong>RSI 5s + Martingale</strong>' +
      '<button id="pos-min" title="Réduire">–</button></div>' +
      '<div class="pos-body">' +
      '<div class="pos-row"><span>RSI</span><b id="pos-rsi">—</b></div>' +
      '<div class="pos-row"><span>Signal</span><b id="pos-signal">En attente…</b></div>' +
      '<div class="pos-row"><span>Palier</span><b id="pos-step">0</b></div>' +
      '<div class="pos-row"><span>Session</span><b id="pos-pnl">0.00 $</b></div>' +
      '<div class="pos-row"><span>W / L</span><b id="pos-wl">0 / 0</b></div>' +
      '<div class="pos-row"><span>Auto-trade</span><b id="pos-auto" class="off">OFF</b></div>' +
      '<div class="pos-actions"><button id="pos-win" class="ok">Gagné</button>' +
      '<button id="pos-loss" class="bad">Perdu</button></div>' +
      '<div class="pos-note">Compte démo uniquement recommandé.</div>' +
      '<details class="pos-discover"><summary>Découverte Socket.IO (<span id="pos-disc-count">0</span>)</summary>' +
      '<div id="pos-disc-list"></div></details>' +
      '<button id="pos-pick">Choisir un élément</button>' +
      '<div id="pos-picked" style="display:none"></div>' +
      "</div>";
    document.body.appendChild(root);

    root.querySelector("#pos-win").addEventListener("click", function () { reportResult(true); });
    root.querySelector("#pos-loss").addEventListener("click", function () { reportResult(false); });
    root.querySelector("#pos-min").addEventListener("click", function () { root.classList.toggle("min"); });
    root.querySelector("#pos-pick").addEventListener("click", function () {
      picking = !picking;
      this.textContent = picking ? "Touche l'élément à capturer…" : "Choisir un élément";
    });
    document.addEventListener("click", onPickClick, true);
  }

  function renderDiscovery() {
    if (!root) return;
    root.querySelector("#pos-disc-count").textContent = String(discovered.size);
    const list = root.querySelector("#pos-disc-list");
    list.innerHTML = "";
    discovered.forEach(function (sample, event) {
      const row = document.createElement("div");
      row.className = "pos-disc-row";
      row.innerHTML =
        '<div class="pos-disc-name">' + event + "</div>" +
        '<div class="pos-disc-sample">' + sample.slice(0, 120).replace(/</g, "&lt;") + "</div>" +
        '<button class="pos-disc-copy">Copier</button>';
      row.querySelector(".pos-disc-copy").addEventListener("click", function () {
        copie(event + " => " + sample);
      });
      list.appendChild(row);
    });
  }

  function render(sig) {
    if (!root) return;
    const rsiVals = candles.length
      ? window.POStrategy.computeRSI(candles.map((c) => c.close), settings.strategy.rsiPeriod)
      : [];
    const lastRsi = rsiVals.length ? rsiVals[rsiVals.length - 1] : NaN;
    root.querySelector("#pos-rsi").textContent = Number.isNaN(lastRsi) ? "—" : lastRsi.toFixed(1);
    if (sig) {
      const el = root.querySelector("#pos-signal");
      if (sig.confirmed) {
        el.textContent = sig.direction === "CALL" ? "▲ CALL (achat)" : "▼ PUT (vente)";
        el.className = sig.direction === "CALL" ? "sig-call" : "sig-put";
      } else {
        el.textContent = "Non confirmé — " + (sig.reason || "");
        el.className = "sig-none";
      }
    }
    root.querySelector("#pos-step").textContent = String(mgStep);
    root.querySelector("#pos-pnl").textContent = (sessionPnL >= 0 ? "+" : "") + sessionPnL.toFixed(2) + " $";
    root.querySelector("#pos-pnl").className = sessionPnL >= 0 ? "ok" : "bad";
    root.querySelector("#pos-wl").textContent = wins + " / " + losses;
    const auto = root.querySelector("#pos-auto");
    auto.textContent = settings.autoTrade ? "ON" : "OFF";
    auto.className = settings.autoTrade ? "on" : "off";
  }

  function notifySignal(sig) {
    flash(
      (sig.direction === "CALL" ? "▲ Signal CALL" : "▼ Signal PUT") +
        " · RSI " + sig.rsi.toFixed(1) +
        " · mèche " + (sig.direction === "PUT" ? sig.wick.upperPct.toFixed(0) : sig.wick.lowerPct.toFixed(0)) + "%",
      sig.direction === "CALL" ? "ok" : "bad"
    );
  }

  let flashTimer;
  function flash(text, tone) {
    let f = document.getElementById("po-strategy-flash");
    if (!f) {
      f = document.createElement("div");
      f.id = "po-strategy-flash";
      document.body.appendChild(f);
    }
    f.textContent = text;
    f.className = "show " + (tone || "");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { f.className = ""; }, 4000);
  }

  // --- Réglages persistés ---
  function loadSettings() {
    chrome.storage.sync.get("poStrategySettings", function (data) {
      if (data && data.poStrategySettings) {
        settings = Object.assign(settings, data.poStrategySettings);
        settings.strategy = Object.assign({}, window.POStrategy.DEFAULT_STRATEGY, data.poStrategySettings.strategy);
        settings.martingale = Object.assign({}, window.POStrategy.DEFAULT_MARTINGALE, data.poStrategySettings.martingale);
      }
      sendConfigToPage();
      render();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync" && changes.poStrategySettings) {
      const v = changes.poStrategySettings.newValue || {};
      settings = Object.assign(settings, v);
      settings.strategy = Object.assign({}, window.POStrategy.DEFAULT_STRATEGY, v.strategy);
      settings.martingale = Object.assign({}, window.POStrategy.DEFAULT_MARTINGALE, v.martingale);
      sendConfigToPage();
      render();
    }
  });

  function init() {
    injectHook();
    buildOverlay();
    loadSettings();
    render();
    console.log("[PO Strategy] content script prêt");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
