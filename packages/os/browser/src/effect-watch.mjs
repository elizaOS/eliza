/**
 * Watches the network of a task tab after each task fill, click, select or
 * scroll, at request start, in every frame. The in-page watch sees only its
 * own document's completed same-site fetch, XHR and beacon requests.
 *
 * After a task effect, a request the page starts before the person takes
 * over is a violation when it is not a GET or HEAD, goes to another site,
 * is a WebSocket, or opens another window; a commit the person said yes to
 * (the page reports it as consented) is let through once. The watch lasts
 * until the binding expires, the next task effect, the host's own
 * navigation, or the main frame commits another document, after which
 * nothing from the watched document can run.
 *
 * It cannot see everything a page's script can do. `unseen` names what it
 * misses, and snapshots say so.
 */

/** What webRequest cannot see: WebRTC data channels send no HTTP request. */
export const NETWORK_WATCH_UNSEEN = Object.freeze(["webrtc"]);

// The page's own site, without public-suffix data, as the in-page watch
// decides it: the last two or three host labels match. This errs toward
// "same site" for hosts under a two-label suffix such as co.uk.
const tail = (host, count) => host.split(".").slice(-count).join(".");
export function sameSite(host, pageHost) {
  return (
    host === pageHost ||
    tail(host, 2) === tail(pageHost, 2) ||
    tail(host, 3) === tail(pageHost, 3)
  );
}

/** True when a request is one a task effect may not set off unseen. */
export function violates(request, pageOrigin) {
  if (request.type === "window" || request.type === "websocket") return true;
  if (!["GET", "HEAD"].includes(request.method)) return true;
  try {
    return !sameSite(
      new URL(request.url).hostname,
      new URL(pageOrigin).hostname,
    );
  } catch {
    return true;
  }
}

// Her press, or her activated control, hands the page over to her, as in
// the in-page watch: anything after her first activated control, or within
// 1.5 s of a press.
const byPerson = (at, handoff) =>
  (Number.isFinite(handoff?.activatedAt) && at >= handoff.activatedAt) ||
  (Array.isArray(handoff?.presses) &&
    handoff.presses.some((press) => at - press >= 0 && at - press <= 1500));

const samePath = (url, other) => {
  try {
    const a = new URL(url);
    const b = new URL(other);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
};

/** Pure watch state for one browser; transports feed it requests. */
export function createNetworkWatch({ now = () => Date.now() } = {}) {
  const watches = new Map();
  return {
    /**
     * Starts a watch before a task effect is dispatched. Returns a cancel
     * that restores the previous watch when the effect was refused before
     * it reached the page.
     */
    arm(tabId, { origin, guidanceScope, expiresAt }) {
      const previous = watches.get(tabId);
      const watch = {
        origin,
        scope: guidanceScope,
        startedAt: now(),
        expiresAt,
        closedAt: Number.POSITIVE_INFINITY,
        candidates: [],
        // A violation stays reported for the rest of this binding.
        violation:
          previous?.scope === guidanceScope ? previous.violation : null,
      };
      watches.set(tabId, watch);
      return () => {
        if (watches.get(tabId) !== watch) return;
        if (previous) watches.set(tabId, previous);
        else watches.delete(tabId);
      };
    },
    /** Ends collection: the host navigated, or a new document committed. */
    close(tabId, at = now()) {
      const watch = watches.get(tabId);
      if (watch) watch.closedAt = Math.min(watch.closedAt, at);
    },
    forget(tabId) {
      watches.delete(tabId);
    },
    /** One request at its start: { url, method, type, at }. */
    observe(tabId, request) {
      const watch = watches.get(tabId);
      if (
        !watch ||
        request.at < watch.startedAt ||
        request.at >= watch.expiresAt ||
        request.at >= watch.closedAt ||
        !violates(request, watch.origin)
      )
        return;
      watch.candidates.push(request);
    },
    /** Tabs whose watch is on an origin, for requests with no tab. */
    tabsOn(origin) {
      return [...watches]
        .filter(([, watch]) => watch.origin === origin)
        .map(([tabId]) => tabId);
    },
    /**
     * The violation for this binding, if any, judged against what the page
     * reports of the person (watchHandoff). Each consented commit URL
     * excuses one request to its origin and path.
     */
    read(tabId, guidanceScope, handoff) {
      const watch = watches.get(tabId);
      if (!watch || watch.scope !== guidanceScope) return null;
      const consented = Array.isArray(handoff?.consentedUrls)
        ? [...handoff.consentedUrls]
        : [];
      for (const request of watch.candidates.splice(0)) {
        if (watch.violation || byPerson(request.at, handoff)) continue;
        const excused = consented.findIndex((url) =>
          samePath(request.url, url),
        );
        if (excused >= 0 && request.type !== "window") {
          consented.splice(excused, 1);
          continue;
        }
        watch.violation = request.type === "window" ? "window" : "request";
      }
      return watch.violation;
    },
  };
}

/** The Chromium extension's watch, fed by webRequest and webNavigation. */
export function createEffectWatch(api) {
  const watch = createNetworkWatch();
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      const request = {
        url: details.url,
        method: details.method,
        type: details.type,
        at: details.timeStamp,
      };
      if (details.tabId >= 0) {
        watch.observe(details.tabId, request);
        return;
      }
      // A service worker's request belongs to no tab. Count it against every
      // tab watching the site the worker serves.
      if (typeof details.initiator === "string")
        for (const tabId of watch.tabsOn(details.initiator))
          watch.observe(tabId, request);
    },
    { urls: ["<all_urls>"] },
  );
  // A window the page opens is out of this watch's sight.
  api.webNavigation.onCreatedNavigationTarget.addListener((details) =>
    watch.observe(details.sourceTabId, {
      url: details.url,
      method: "GET",
      type: "window",
      at: details.timeStamp,
    }),
  );
  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) watch.close(details.tabId, details.timeStamp);
  });
  api.tabs.onRemoved.addListener((tabId) => watch.forget(tabId));
  return watch;
}
