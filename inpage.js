/**
 * Tourne dans le contexte JS de la page (pas le monde isolé de l'extension) —
 * seul moyen d'intercepter les WebSocket ouverts par la page elle-même.
 *
 * Le flux Pocket Option utilise Socket.IO (EIO=4). Format des trames reçues :
 *   "0{...}"   -> open (handshake)
 *   "40..."    -> connect
 *   "2"        -> ping serveur
 *   "3"        -> pong client
 *   "42[\"nom-event\", {...}]" -> événement applicatif (c'est ce qui nous intéresse)
 */

(function () {
  const seenEvents = new Set();
  let config = { eventFilter: "", priceField: "price" };

  function post(source, payload) {
    window.postMessage(Object.assign({ source: source }, payload), "*");
  }

  function safeStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  // Cherche récursivement une clé dans un objet imbriqué (ex: "price", "rate", "close")
  function deepFind(obj, key, depth) {
    depth = depth || 0;
    if (obj == null || typeof obj !== "object" || depth > 4) return undefined;
    if (key in obj) return obj[key];
    for (const k in obj) {
      const found = deepFind(obj[k], key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function parseSocketIOFrame(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/^(\d+)([\s\S]*)$/);
    if (!m) return null;
    const prefix = m[1];
    const rest = m[2];

    // "42" = event, "43" = ack avec données (parfois utilisé aussi pour des résultats)
    if (prefix === "42" || prefix === "43") {
      try {
        const arr = JSON.parse(rest);
        if (Array.isArray(arr) && typeof arr[0] === "string") {
          return { event: arr[0], payload: arr[1] };
        }
      } catch (e) {
        // frame non-JSON après le préfixe : ignorée
      }
    }
    return null;
  }

  function handleFrame(raw) {
    const parsed = parseSocketIOFrame(raw);
    if (!parsed) return;
    const event = parsed.event;
    const payload = parsed.payload;

    // Mode découverte : signale chaque événement distinct une seule fois,
    // avec un échantillon tronqué, pour que l'overlay puisse l'afficher.
    if (!seenEvents.has(event)) {
      seenEvents.add(event);
      post("PO_STRATEGY_DISCOVER", { event: event, sample: safeStringify(payload).slice(0, 500) });
    }

    // Mode live : une fois l'événement de prix identifié et configuré
    if (config.eventFilter && event === config.eventFilter) {
      const raw = deepFind(payload, config.priceField);
      const price = Number(raw);
      if (!Number.isNaN(price) && price > 0) {
        post("PO_STRATEGY_TICK", { tick: { price: price, time: Date.now() } });
      }
    }
  }

  // Réception de la config depuis content.js (nom d'événement, champ du prix)
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data && event.data.source === "PO_STRATEGY_CONFIG") {
      config = Object.assign(config, event.data.config);
    }
  });

  const NativeWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const ws = protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    ws.addEventListener("message", function (event) {
      handleFrame(event.data);
    });
    return ws;
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  window.WebSocket = PatchedWebSocket;

  // ---------- Interception au niveau des Web Workers ----------
  // Beaucoup de plateformes ouvrent leur WebSocket dans un Worker dédié
  // (hors thread principal). Le patch ci-dessus ne peut pas le voir : il
  // faut injecter un patch équivalent DANS le worker lui-même. On
  // intercepte donc la création du Worker, on récupère son code source,
  // on lui ajoute notre patch en préambule, puis on le relance via un
  // Blob. Le worker patché relaie ensuite les trames via BroadcastChannel
  // (le seul canal simple entre un worker et la page principale qui ne
  // perturbe pas la communication postMessage propre à l'application).
  const WORKER_PATCH = [
    "(function(){",
    "  try {",
    "    var bc = new BroadcastChannel('po-strategy-bridge');",
    "    var seen = {};",
    "    function post(type, data) { try { bc.postMessage(Object.assign({ type: type }, data)); } catch (e) {} }",
    "    function parseFrame(raw) {",
    "      if (typeof raw !== 'string') return null;",
    "      var m = raw.match(/^(\\d+)([\\s\\S]*)$/);",
    "      if (!m) return null;",
    "      var prefix = m[1], rest = m[2];",
    "      if (prefix === '42' || prefix === '43') {",
    "        try {",
    "          var arr = JSON.parse(rest);",
    "          if (Array.isArray(arr) && typeof arr[0] === 'string') return { event: arr[0], payload: arr[1] };",
    "        } catch (e) {}",
    "      }",
    "      return null;",
    "    }",
    "    var NativeWS = self.WebSocket;",
    "    function PatchedWS(url, protocols) {",
    "      var ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);",
    "      ws.addEventListener('message', function (ev) {",
    "        var parsed = parseFrame(ev.data);",
    "        if (!parsed) return;",
    "        if (!seen[parsed.event]) {",
    "          seen[parsed.event] = true;",
    "          post('discover', { event: parsed.event, sample: JSON.stringify(parsed.payload).slice(0, 500) });",
    "        }",
    "        post('raw', { event: parsed.event, payload: parsed.payload });",
    "      });",
    "      return ws;",
    "    }",
    "    PatchedWS.prototype = NativeWS.prototype;",
    "    self.WebSocket = PatchedWS;",
    "  } catch (e) {}",
    "})();",
  ].join("\n");

  const NativeWorker = window.Worker;
  function PatchedWorker(scriptURL, options) {
    try {
      const abs = new URL(scriptURL, location.href).href;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", abs, false); // synchrone : nécessaire, le constructeur Worker est synchrone
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = new Blob([WORKER_PATCH + "\n" + xhr.responseText], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        return new NativeWorker(blobUrl, options);
      }
    } catch (e) {
      // Script cross-origin, CSP bloquante, etc. — on retombe sur le Worker natif.
    }
    return new NativeWorker(scriptURL, options);
  }
  PatchedWorker.prototype = NativeWorker.prototype;
  window.Worker = PatchedWorker;

  try {
    const bridge = new BroadcastChannel("po-strategy-bridge");
    bridge.onmessage = function (ev) {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "discover") {
        if (!seenEvents.has(msg.event)) {
          seenEvents.add(msg.event);
          post("PO_STRATEGY_DISCOVER", { event: msg.event, sample: msg.sample });
        }
      } else if (msg.type === "raw") {
        if (config.eventFilter && msg.event === config.eventFilter) {
          const price = Number(deepFind(msg.payload, config.priceField));
          if (!Number.isNaN(price) && price > 0) {
            post("PO_STRATEGY_TICK", { tick: { price: price, time: Date.now() } });
          }
        }
      }
    };
  } catch (e) {
    // BroadcastChannel indisponible dans ce contexte — tant pis, le hook
    // principal (hors worker) continue de fonctionner seul.
  }

  post("PO_STRATEGY_READY", {});
})();
