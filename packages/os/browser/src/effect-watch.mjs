/**
 * Watches the network of a task tab after each task fill, click, select or
 * scroll, at request start, in every frame. The in-page watch sees only its
 * own document's completed same-site fetch, XHR and beacon requests.
 *
 * After a task effect, a request the page starts before the person takes
 * over is a violation when it is not a GET or HEAD, is a WebSocket, or opens
 * another window; after a click, also a fetch, XHR or frame GET to another
 * site (row C10). A top-level GET navigation is left to the in-page watch and
 * the navigation gate, which already allow a click on a link to open that
 * link, redirects included. The one commit a grant consents is let through
 * once, and so are the redirect hops of that request. The watch lasts until
 * the binding expires, the next task effect, the host's own navigation, or
 * the main frame commits another document, after which nothing from the
 * watched document can run.
 *
 * Real sites keep talking to other sites on their own: analytics beacons,
 * CDN images, scripts and fonts, ad pixels. Nothing ties such a request to
 * the task's effect, so the watch counts what the effect plausibly caused:
 * a beacon or report to another site is never a violation, a cross-site
 * image, font, stylesheet, script or media read is not one either (it reads;
 * the page could send it without the effect), and any other cross-site
 * request counts only within CROSS_SITE_WINDOW_MS of the effect. Writes to
 * the page's own site, a top-level POST, WebSockets to its own site and
 * windows count for the whole watch, so a page that writes to its own site on
 * a timer (a session keep-alive POST) still pauses the task.
 *
 * It cannot see everything a page's script can do. `unseen` names what it
 * misses, and snapshots say so.
 */

/** What webRequest cannot see: WebRTC data channels send no HTTP request. */
export const NETWORK_WATCH_UNSEEN = Object.freeze(["webrtc"]);

/** Task effects the network watch follows. */
export const WATCHED_EFFECTS = Object.freeze([
  "click",
  "fill",
  "select",
  "scroll",
]);

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

const reads = (request) => ["GET", "HEAD"].includes(request.method);

/** How long after an effect a request to another site can be its doing. */
export const CROSS_SITE_WINDOW_MS = 30000;
// Fire-and-forget telemetry: sendBeacon, <a ping> and CSP reports.
const TELEMETRY = ["ping", "csp_report"];
// Reads that load what the page shows or runs.
const PASSIVE = ["image", "imageset", "font", "stylesheet", "script", "media"];

/**
 * True when a request is one a task effect may not set off unseen.
 * `sinceEffect` is how long after the effect the request started. A GET to
 * another site counts only after a click: a fill, select or scroll often
 * loads images or suggestions from another site, and sends nothing she did
 * not see unless it writes.
 */
export function violates(
  request,
  pageOrigin,
  subaction = "click",
  sinceEffect = 0,
) {
  if (request.type === "window") return true;
  let crossSite;
  try {
    crossSite = !sameSite(
      new URL(request.url).hostname,
      new URL(pageOrigin).hostname,
    );
  } catch {
    crossSite = true;
  }
  if (
    crossSite &&
    request.type !== "main_frame" &&
    (TELEMETRY.includes(request.type) || sinceEffect > CROSS_SITE_WINDOW_MS)
  )
    return false;
  if (request.type === "websocket" || !reads(request)) return true;
  if (request.type === "main_frame" || subaction !== "click") return false;
  return crossSite && !PASSIVE.includes(request.type);
}

// Her press, or her activated control, hands the page over to her, as in
// the in-page watch: anything after her first activated control, or within
// 1.5 s of a press.
const byPerson = (at, watch) => {
  if (at >= watch.activatedAt) return true;
  for (const press of watch.presses)
    if (at - press >= 0 && at - press <= 1500) return true;
  return false;
};

const withoutHash = (url, base) => {
  const parsed = new URL(url, base);
  parsed.hash = "";
  return parsed;
};
// A commit URL the grant names. `exact` matches the whole address; otherwise
// origin and path, as for a consented URL the page reports.
const matches = (request, allowed, base) => {
  try {
    const a = withoutHash(request.url);
    const b = withoutHash(allowed.url, base);
    if (allowed.method && allowed.method !== request.method) return false;
    return allowed.exact
      ? a.href === b.href
      : a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
};

/** Pure watch state for one browser; transports feed it requests. */
export function createNetworkWatch({ now = () => Date.now() } = {}) {
  const watches = new Map();
  // Judges what a watch has collected. A grant's commit is known from the
  // grant itself and from the page's click result, so a request in flight is
  // judged at once and never waits for the page to see it complete.
  const settle = (watch) => {
    for (const request of watch.candidates.splice(0)) {
      if (watch.violation || byPerson(request.at, watch)) continue;
      if (
        request.requestId !== undefined &&
        watch.excused.has(request.requestId)
      )
        continue;
      if (
        watch.grant &&
        !watch.grant.spent &&
        request.type !== "window" &&
        watch.grant.allowed.some((allowed) =>
          matches(request, allowed, watch.origin),
        )
      ) {
        watch.grant.spent = true;
        if (request.requestId !== undefined)
          watch.excused.add(request.requestId);
        continue;
      }
      watch.violation = request.type === "window" ? "window" : "request";
    }
  };
  // The effect before this watch's own, once nothing more about it can
  // arrive: its verdict carries into this binding's watch.
  const settlePrevious = (watch) => {
    const previous = watch.previous;
    if (!previous) return;
    watch.previous = null;
    settle(previous);
    watch.violation ??= previous.violation;
  };
  // What the page saw of the person and of the granted commit. The page's
  // reports only add to a grant the host issued; without one they excuse
  // nothing. The page sends all its presses each time; a Set keeps each once.
  const merge = (watch, handoff) => {
    if (!handoff || typeof handoff !== "object") return;
    if (Array.isArray(handoff.presses))
      for (const press of handoff.presses)
        if (Number.isFinite(press)) watch.presses.add(press);
    if (Number.isFinite(handoff.activatedAt))
      watch.activatedAt = Math.min(watch.activatedAt, handoff.activatedAt);
    if (!watch.grant) return;
    const expected = handoff.expected;
    if (expected && typeof expected.url === "string")
      watch.grant.allowed.push({
        url: expected.url,
        method:
          typeof expected.method === "string" ? expected.method : undefined,
        exact: expected.exact === true,
      });
    if (Array.isArray(handoff.consentedUrls))
      for (const url of handoff.consentedUrls)
        if (typeof url === "string")
          watch.grant.allowed.push({ url, exact: false });
  };
  return {
    /**
     * Starts a watch before a task effect is dispatched. Returns a cancel
     * that restores the previous watch when the effect was refused before
     * it reached the page.
     */
    arm(
      tabId,
      { origin, guidanceScope, expiresAt, commitGrant },
      subaction = "click",
    ) {
      const previous = watches.get(tabId);
      // The earlier effect is judged once this effect's result hands over
      // what the page saw of her since the last read (report), or at the next
      // read; one before it gets no later report and is judged now.
      if (previous) settlePrevious(previous);
      const target = commitGrant?.requestTarget;
      const watch = {
        origin,
        scope: guidanceScope,
        subaction,
        startedAt: now(),
        expiresAt,
        closedAt: Number.POSITIVE_INFINITY,
        hostClosedAt: Number.POSITIVE_INFINITY,
        candidates: [],
        presses: new Set(),
        activatedAt: Number.POSITIVE_INFINITY,
        excused: new Set(),
        // The one commit the host's grant consents, by every address it may
        // have: the grant's request target, and what the page reports.
        grant: commitGrant
          ? {
              spent: false,
              allowed: target
                ? [
                    {
                      url: target.url ?? target.path,
                      method: target.method,
                      exact: true,
                    },
                  ]
                : [],
            }
          : null,
        // A violation stays reported for the rest of this binding.
        violation:
          previous?.scope === guidanceScope ? previous.violation : null,
        previous: previous?.scope === guidanceScope ? previous : null,
      };
      watches.set(tabId, watch);
      return () => {
        if (watches.get(tabId) !== watch) return;
        if (previous) watches.set(tabId, previous);
        else watches.delete(tabId);
      };
    },
    /**
     * Ends collection: a new document committed, or (`host`) the host's own
     * navigation is about to run. A host close returns a reopen for when the
     * navigation was refused and the page stayed; a commit stays closed.
     */
    close(tabId, at = now(), { host = false } = {}) {
      const watch = watches.get(tabId);
      if (!watch) return () => {};
      if (!host) {
        watch.closedAt = Math.min(watch.closedAt, at);
        return () => {};
      }
      const hostClosedAt = watch.hostClosedAt;
      watch.hostClosedAt = Math.min(watch.hostClosedAt, at);
      return () => {
        watch.hostClosedAt = hostClosedAt;
      };
    },
    forget(tabId) {
      watches.delete(tabId);
    },
    /** One request at its start: { url, method, type, at, requestId? }. */
    observe(tabId, request) {
      const watch = watches.get(tabId);
      if (
        !watch ||
        request.at < watch.startedAt ||
        request.at >= watch.expiresAt ||
        request.at >= watch.closedAt ||
        request.at >= watch.hostClosedAt ||
        !violates(
          request,
          watch.origin,
          watch.subaction,
          request.at - watch.startedAt,
        )
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
     * Adds what the page reports (watchHandoff) to this binding's watch
     * without judging: a task effect's own result. `previousHandoff` is what
     * the page's earlier watch saw up to this effect (her presses since the
     * last read); it goes to the earlier effect's watch alone, which is then
     * judged, so her press can never excuse this effect's requests.
     */
    report(tabId, guidanceScope, handoff, previousHandoff) {
      const watch = watches.get(tabId);
      if (!watch || watch.scope !== guidanceScope) return;
      if (watch.previous && previousHandoff?.scope === watch.previous.scope)
        merge(watch.previous, previousHandoff);
      settlePrevious(watch);
      merge(watch, handoff);
    },
    /**
     * The violation for this binding, if any, judged after adding what the
     * page reports of the person and of the granted commit (watchHandoff).
     */
    read(tabId, guidanceScope, handoff) {
      const watch = watches.get(tabId);
      if (!watch || watch.scope !== guidanceScope) return null;
      settlePrevious(watch);
      merge(watch, handoff);
      settle(watch);
      return watch.violation;
    },
  };
}

/**
 * Takes the page's watchHandoff out of a task result and hands it to the
 * network watch: a task effect's result only reports it, a task snapshot's
 * main frame is judged and carries the verdict. The handoff never reaches a
 * host.
 */
export function applyEffectWatch(effects, command, result) {
  const scope = command.taskPolicy?.guidanceScope;
  if (WATCHED_EFFECTS.includes(command.subaction) && result) {
    const { watchHandoff, previousWatchHandoff } = result;
    delete result.watchHandoff;
    delete result.previousWatchHandoff;
    if (effects && scope !== undefined)
      effects.report(
        Number(command.id),
        scope,
        watchHandoff,
        previousWatchHandoff,
      );
    return;
  }
  for (const frame of result?.frames || []) {
    const { watchHandoff } = frame;
    delete frame.watchHandoff;
    if (
      !effects ||
      frame.frameId !== 0 ||
      scope === undefined ||
      command.subaction !== "snapshot"
    )
      continue;
    const violation = effects.read(Number(command.id), scope, watchHandoff);
    if (violation && frame.effectViolation === undefined)
      frame.effectViolation = violation;
    frame.effectWatch = { frames: "all", unseen: NETWORK_WATCH_UNSEEN };
  }
}

/** The Chromium extension's watch, fed by webRequest and webNavigation. */
export function createEffectWatch(api) {
  const watch = createNetworkWatch();
  // Each tab's top-level origin, so a service worker's request is not pinned
  // on the task tab while another tab of that site may have sent it.
  const tabOrigins = new Map();
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      const request = {
        url: details.url,
        method: details.method,
        type: details.type,
        at: details.timeStamp,
        requestId: details.requestId,
      };
      if (details.tabId >= 0) {
        watch.observe(details.tabId, request);
        return;
      }
      // A service worker's request belongs to no tab. Count it against every
      // tab watching the site the worker serves, unless a tab the watch does
      // not follow is on that site too: the request may be the person's,
      // from that tab.
      if (typeof details.initiator !== "string") return;
      const watching = watch.tabsOn(details.initiator);
      for (const [tabId, tabOrigin] of tabOrigins)
        if (tabOrigin === details.initiator && !watching.includes(tabId))
          return;
      for (const tabId of watching) watch.observe(tabId, request);
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
    if (details.frameId !== 0) return;
    watch.close(details.tabId, details.timeStamp);
    try {
      tabOrigins.set(details.tabId, new URL(details.url).origin);
    } catch {
      tabOrigins.delete(details.tabId);
    }
  });
  api.tabs.onRemoved.addListener((tabId) => {
    tabOrigins.delete(tabId);
    watch.forget(tabId);
  });
  return watch;
}
