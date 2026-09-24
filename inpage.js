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

  post("PO_STRATEGY_READY", {});
})();
