/**
 * Coalesces backend source changes into readiness-gated API restarts. Source
 * edits that arrive during boot remain pending until the runtime is healthy, so
 * a module imported earlier in the boot cannot remain stale for the session.
 */

const DEFAULT_RETRY_MS = 400;

/**
 * @typedef {Object} AgentSourceReloadRequest
 * @property {string} relPath
 * @property {number} changedCount
 */

/**
 * @typedef {Object} AgentSourceReloadQueueOptions
 * @property {() => boolean | Promise<boolean>} isReady
 * @property {() => void} restart
 * @property {() => boolean} isShuttingDown
 * @property {(request: AgentSourceReloadRequest) => void} [onReload]
 * @property {number} [retryMs]
 */

/**
 * Keep at most one source reload pending. The API supervisor remains the owner
 * of process lifecycle and overlapping-kill coalescing; this queue only waits
 * for the current child to finish booting before asking for a restart.
 *
 * @param {AgentSourceReloadQueueOptions} options
 */
export function createAgentSourceReloadQueue(options) {
  const {
    isReady,
    restart,
    isShuttingDown,
    onReload,
    retryMs = DEFAULT_RETRY_MS,
  } = options;

  /** @type {AgentSourceReloadRequest | null} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  let probeInFlight = false;
  let closed = false;

  function scheduleProbe(delayMs = 0) {
    if (
      closed ||
      isShuttingDown() ||
      pending === null ||
      probeInFlight ||
      retryTimer
    ) {
      return;
    }

    if (delayMs > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleProbe();
      }, delayMs);
      retryTimer.unref?.();
      return;
    }

    void probeReadiness();
  }

  async function probeReadiness() {
    if (closed || isShuttingDown() || pending === null || probeInFlight) {
      return;
    }

    probeInFlight = true;
    let ready = false;
    try {
      ready = await isReady();
    } catch {
      // error-policy:J1 A readiness probe translates transport failure into
      // an explicit retryable not-ready result at the process boundary.
      // A transport failure is the expected shape while the API child is
      // between processes; retain the request and retry the health boundary.
      ready = false;
    } finally {
      probeInFlight = false;
    }

    if (closed || isShuttingDown() || pending === null) return;
    if (!ready) {
      scheduleProbe(retryMs);
      return;
    }

    const request = pending;
    pending = null;
    onReload?.(request);
    restart();

    // A source event can arrive while callbacks above run. Preserve it as a
    // separate generation so the next child cannot miss that later edit.
    if (pending !== null) scheduleProbe();
  }

  return {
    /** @param {AgentSourceReloadRequest} request */
    requestReload(request) {
      if (closed || isShuttingDown()) return;
      pending = request;
      scheduleProbe();
    },
    close() {
      closed = true;
      pending = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}
