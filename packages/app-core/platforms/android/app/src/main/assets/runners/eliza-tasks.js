/*
 * Eliza background runner — fired by Capacitor BackgroundRunner inside a
 * separate JSContext (iOS QuickJS, Android V8) per wake event.
 *
 * Sandboxed env: no window, no localStorage, no IndexedDB, no cookied fetch.
 * Available globals: setTimeout, Promise, console, fetch (no cookies),
 * CapacitorBackgroundRunner.addEventListener.
 *
 * Contract:
 *   args: {
 *     kind: 'refresh' | 'processing',
 *     deadlineSec: number,
 *     deviceSecret: string,
 *     agentBase: string,        // e.g. 'http://127.0.0.1:31337'
 *   }
 *
 * Resolves with { delivered: true, ...result } on success; rejects with
 * { delivered: false, error } on failure or deadline.
 *
 * The host app's main webview (FGS on Android, foreground process on iOS)
 * owns the long-lived AgentRuntime; this runner pokes it via loopback HTTP
 * and returns. Every wake-up runs once and then the JSContext is suspended.
 */

addEventListener("wake", (resolve, reject, args) => {
  handleWake(args).then(resolve, reject);
});

/**
 * Entry point exposed for unit testing. The addEventListener handler above
 * is the production binding; this function is the testable body.
 *
 * @param {{kind: 'refresh' | 'processing', deadlineSec: number, deviceSecret: string, agentBase: string}} args
 * @returns {Promise<{delivered: boolean, ranTasks?: number, durationMs?: number, lastWakeFiredAt?: number}>}
 */
function handleWake(args) {
  const kind = args && args.kind;
  const deadlineSec = args && Number(args.deadlineSec);
  const deviceSecret = args && args.deviceSecret;
  const agentBase = args && args.agentBase;

  if (kind !== "refresh" && kind !== "processing") {
    return Promise.reject({
      delivered: false,
      error: 'invalid args: kind must be "refresh" or "processing"',
    });
  }
  if (
    !Number.isFinite(deadlineSec) ||
    deadlineSec <= 0
  ) {
    return Promise.reject({
      delivered: false,
      error: "invalid args: deadlineSec must be a positive number",
    });
  }
  if (typeof deviceSecret !== "string" || deviceSecret.length === 0) {
    return Promise.reject({
      delivered: false,
      error: "invalid args: deviceSecret must be a non-empty string",
    });
  }
  if (typeof agentBase !== "string" || agentBase.length === 0) {
    return Promise.reject({
      delivered: false,
      error: "invalid args: agentBase must be a non-empty string",
    });
  }

  // OS gives ~30s on iOS, more on Android. Leave 2-3s buffer so the POST
  // body can flush and we can resolve before the OS kills the JSContext.
  var BUFFER_MS = 2500;
  var hardDeadlineMs = Math.max(1000, deadlineSec * 1000 - BUFFER_MS);
  var startedAt = Date.now();
  var wakeDeadlineAt = startedAt + hardDeadlineMs;

  var url = trimTrailingSlash(agentBase) + "/api/internal/wake";
  // Wrap in Promise.resolve().then so that a synchronous throw inside the
  // sandboxed fetch() (rare, but observed under hostile mocks and the iOS
  // QuickJS network stack when no route is registered) becomes a rejection
  // we can race against the deadline.
  var workPromise = Promise.resolve()
    .then(function () {
      return fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + deviceSecret,
        },
        body: JSON.stringify({
          kind: kind,
          deadlineMs: wakeDeadlineAt,
        }),
      });
    })
    .then(function (response) {
      if (!response || !response.ok) {
        var status = response ? response.status : "no-response";
        throw new Error("wake POST failed: status=" + status);
      }
      return response.json();
    });

  var deadlinePromise = new Promise(function (_resolve, reject) {
    setTimeout(function () {
      reject(new Error("wake deadline reached after " + hardDeadlineMs + "ms"));
    }, hardDeadlineMs);
  });

  return Promise.race([workPromise, deadlinePromise])
    .then(function (result) {
      var safe = result && typeof result === "object" ? result : {};
      return {
        delivered: true,
        ranTasks:
          typeof safe.ranTasks === "number" ? safe.ranTasks : 0,
        durationMs:
          typeof safe.durationMs === "number"
            ? safe.durationMs
            : Date.now() - startedAt,
        lastWakeFiredAt:
          typeof safe.lastWakeFiredAt === "number"
            ? safe.lastWakeFiredAt
            : Date.now(),
      };
    })
    .catch(function (error) {
      var msg =
        error && error.message
          ? error.message
          : typeof error === "string"
            ? error
            : "unknown error";
      console.error("[eliza-tasks] wake failed: " + msg);
      return Promise.reject({ delivered: false, error: msg });
    });
}

function trimTrailingSlash(value) {
  if (typeof value !== "string") return value;
  return value.charAt(value.length - 1) === "/"
    ? value.substring(0, value.length - 1)
    : value;
}

// Export `handleWake` to the global scope so unit tests can exercise it
// without depending on the Capacitor addEventListener binding. In the real
// runner this is harmless — the JSContext is recreated per wake.
if (typeof globalThis !== "undefined") {
  globalThis.handleWake = handleWake;
}
