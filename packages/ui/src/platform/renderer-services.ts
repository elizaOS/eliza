/**
 * Lifecycle registry for renderer-side background services — long-lived,
 * non-React work (pollers, native listeners, capture loops) that plugins start
 * in the browser renderer and that must be stopped again, never orphaned.
 *
 * Two halves meet here. Plugin side-effect registration entries (the
 * `elizaos.appRegister` modules the app shell imports after first paint) call
 * `registerRendererService` with a scoped definition instead of starting work
 * at import time. The app shell calls `startRendererServiceHost` exactly once
 * per renderer window with the window's resolved shell kind; the host starts
 * every eligible definition, retains the cleanup each `start` returns, and
 * invokes it on page teardown (`pagehide`), on host replacement, and when a
 * definition re-registers under the same id (dev HMR re-evaluating a plugin
 * registration module). Registration and host startup are order-independent:
 * definitions registered before the host exists start when it arrives, and
 * definitions registered later (side-effect modules load on the idle path)
 * start immediately.
 *
 * Cleanup is allowed to be asynchronous (owned native resources — listeners,
 * monitors — stop asynchronously), so every id-scoped transition (stop then
 * replacement start, whether triggered by re-registration or host
 * replacement) is serialized: a successor's `start` never runs until the
 * predecessor's cleanup promise has settled, resolved or rejected. A
 * rejecting cleanup is reported through the host's `reportError` and still
 * unblocks the successor — teardown never deadlocks the registry, and a
 * failure is always surfaced, never swallowed. `disposeHost` returns a
 * promise that resolves once every instance it stopped has fully settled;
 * `startRendererServiceHost` makes every newly started instance await that
 * promise before it starts, so a replaced generation's in-flight teardown
 * (e.g. a native `stopMonitoring()` call) can never land after the
 * replacement's `start` and clobber it (#17110). Each instance keeps its own
 * `AbortController`/generation identity, so a stale instance's late
 * completion (a delayed start, or cleanup settling long after a successor is
 * already running) can only ever act on itself — it is discarded rather than
 * mutating the successor's state.
 *
 * A `pagehide` with `persisted=true` (bfcache entry, e.g. iOS Safari
 * back-nav) suspends every instance through the same serialized stop path
 * instead of disposing the host outright — the page may come back via
 * `pageshow`, which restarts every eligible definition through the same
 * serialized start path (awaiting a still-in-flight suspension first). Only a
 * real `pagehide` (`persisted=false`) fully disposes the host.
 *
 * The store lives on `globalThis` so duplicated module evaluations (HMR, mixed
 * chunk graphs) share one registry — two copies of this module must never each
 * believe they own the running instances. Stop is race-safe against pending
 * starts: stopping while `start` is still awaited marks the instance stopped,
 * and the settled start's cleanup runs immediately instead of leaking. A
 * `start` that resolves without a cleanup function is a contract violation and
 * is reported as a failure — silently discarded disposers are exactly the bug
 * this module exists to prevent (#16504).
 */

import { reportRendererDiagnostic } from "../utils/renderer-diagnostics";

/**
 * Renderer window shells the app boots. Only the app shell assigns these; a
 * service declares which shells it may run in via `shells`, so background work
 * like LifeOps activity capture runs once in the primary window instead of in
 * every popout/detached/companion renderer.
 */
export type RendererShellKind =
  | "main"
  | "popout"
  | "detached"
  | "chat-overlay"
  | "tray-popover"
  | "phone-companion"
  | "app-window"
  | "embed";

/** Passed to a service `start`; `signal` aborts when this instance is stopped. */
export interface RendererServiceContext {
  shell: RendererShellKind;
  signal: AbortSignal;
}

/** May resolve asynchronously — the registry awaits it before starting a successor. */
export type RendererServiceCleanup = () => void | Promise<void>;

export interface RendererServiceDefinition {
  /** Globally unique, stable id, e.g. "personal-assistant.lifeops-activity-signals". */
  id: string;
  /** Shell kinds this service is allowed to run in. */
  shells: readonly RendererShellKind[];
  /**
   * Start the service. Must return (or resolve to) the cleanup that undoes
   * every listener/interval/native handle it installed. May be async; the host
   * guarantees the cleanup still runs if the instance is stopped mid-start.
   */
  start: (
    context: RendererServiceContext,
  ) => RendererServiceCleanup | Promise<RendererServiceCleanup>;
}

export type RendererServiceStatus =
  | "registered"
  | "ineligible"
  | "starting"
  | "running"
  | "failed"
  | "stopped";

export interface RendererServiceState {
  id: string;
  shells: readonly RendererShellKind[];
  status: RendererServiceStatus;
}

export type RendererServiceErrorReporter = (
  serviceId: string,
  error: unknown,
  phase: "start" | "cleanup",
) => void;

export interface RendererServiceHostHandle {
  shell: RendererShellKind;
  /**
   * Stop every running/starting instance and detach the pagehide/pageshow
   * hooks. Returns a promise that settles once every instance's cleanup has
   * fully run; callers that only need to enqueue the stop may ignore it.
   */
  dispose: () => void | Promise<void>;
}

interface ServiceInstance {
  definition: RendererServiceDefinition;
  controller: AbortController;
  status: "starting" | "running" | "failed" | "stopped";
  cleanup: RendererServiceCleanup | null;
  /**
   * Settles once this instance's `start` (if still pending) and any cleanup
   * it triggers have both fully resolved — the single signal a successor
   * (same id re-registration, or the next host generation) awaits before it
   * is allowed to start.
   */
  settled: Promise<void>;
}

interface HostState {
  shell: RendererShellKind;
  reportError: RendererServiceErrorReporter;
  instances: Map<string, ServiceInstance>;
  /** Id-scoped teardown in flight; a same-id start awaits this before running. */
  pendingCleanup: Map<string, Promise<void>>;
  detachLifecycleHooks: (() => void) | null;
  disposed: boolean;
}

interface RendererServiceStore {
  definitions: Map<string, RendererServiceDefinition>;
  host: HostState | null;
}

// Why a `globalThis` store and not a module-local one, given the #12091
// "kill globalThis bridges" doctrine: this registry's single invariant is that
// exactly one copy owns the running instances, but the renderer cannot
// guarantee single evaluation of this module — dev HMR re-evaluates it, and a
// plugin registration chunk and the app shell chunk can each bundle their own
// copy (mixed chunk graphs). A module-local store forks per evaluation, which
// is precisely the double-ownership bug this exists to prevent. Routing
// through the app's loader-identity cache instead was rejected because it
// inverts the dependency direction (#12091: packages/ui must not reach into
// packages/app machinery) and would leave non-app hosts (tests, storybook-like
// harnesses) without a registry. Symbol.for gives every copy the same key
// without exporting a mutable global surface; `resetRendererServicesForTest`
// is the only sanctioned reset path.
const STORE_KEY = Symbol.for("elizaos.renderer-services.store");

function getStore(): RendererServiceStore {
  const holder = globalThis as { [STORE_KEY]?: RendererServiceStore };
  holder[STORE_KEY] ??= { definitions: new Map(), host: null };
  return holder[STORE_KEY];
}

const LOG_PREFIX = "[RendererServices]";

const defaultReportError: RendererServiceErrorReporter = (
  serviceId,
  error,
  phase,
) => {
  reportRendererDiagnostic({
    scope: `renderer-service.${phase}`,
    error,
    context: { serviceId },
  });
};

/**
 * Invoke a retained cleanup and return a promise that settles once it (sync
 * or async) has fully run. Never rejects: a throwing/rejecting cleanup is
 * reported through the host's reporter instead, so a failed teardown can
 * never deadlock a successor waiting on it.
 */
function runCleanup(host: HostState, instance: ServiceInstance): Promise<void> {
  const cleanup = instance.cleanup;
  instance.cleanup = null;
  if (!cleanup) return Promise.resolve();
  const reportFailure = (error: unknown): void => {
    // error-policy:J6 best-effort teardown — a throwing/rejecting cleanup
    // must not block the remaining services' teardown or a waiting
    // successor's start; it is reported, never swallowed.
    host.reportError(instance.definition.id, error, "cleanup");
  };
  try {
    const result = cleanup();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).catch(reportFailure);
    }
    return Promise.resolve();
  } catch (error) {
    reportFailure(error);
    return Promise.resolve();
  }
}

/**
 * Mark an instance stopped, invoke (or arrange) its cleanup, and register the
 * settling promise under the instance's id so a same-id `startInstance` call
 * — from re-registration or the next host generation — waits for it. Returns
 * that same promise.
 */
function stopInstance(
  host: HostState,
  instance: ServiceInstance,
): Promise<void> {
  if (instance.status === "stopped") {
    return host.pendingCleanup.get(instance.definition.id) ?? Promise.resolve();
  }
  const id = instance.definition.id;
  const wasStarting = instance.status === "starting";
  instance.status = "stopped";
  instance.controller.abort();
  // If start is still pending, `instance.settled`'s continuation sees the
  // aborted signal and runs (and awaits) the late cleanup itself once the
  // start resolves; that same promise is what a waiting successor needs.
  // Otherwise the retained cleanup runs now.
  const settled = wasStarting ? instance.settled : runCleanup(host, instance);
  if (host.instances.get(id) === instance) {
    host.instances.delete(id);
  }
  host.pendingCleanup.set(id, settled);
  void settled.finally(() => {
    if (host.pendingCleanup.get(id) === settled) {
      host.pendingCleanup.delete(id);
    }
  });
  return settled;
}

/**
 * Start a new instance for `definition`. If `waitFor` is given (the prior
 * host generation's full disposal) or a same-id teardown is already pending
 * on this host (re-registration), `start` is not invoked until that teardown
 * has settled — this is the serialization guarantee (#17110): a predecessor's
 * async cleanup always finishes before its successor starts.
 */
function startInstance(
  host: HostState,
  definition: RendererServiceDefinition,
  waitFor?: Promise<void>,
): void {
  const controller = new AbortController();
  const instance: ServiceInstance = {
    definition,
    controller,
    status: "starting",
    cleanup: null,
    settled: Promise.resolve(),
  };
  host.instances.set(definition.id, instance);

  instance.settled = (async () => {
    if (waitFor) {
      await waitFor;
    }
    // Check supersession BEFORE consulting pendingCleanup: a stop that landed
    // while this instance awaited the prior generation's disposal parked this
    // instance's own `settled` there, and awaiting it from inside itself
    // would deadlock the id (and every later host generation) forever.
    // Nothing started yet, so resolving immediately is the correct teardown.
    if (host.instances.get(definition.id) !== instance) {
      return;
    }
    const pendingSameId = host.pendingCleanup.get(definition.id);
    if (pendingSameId) {
      await pendingSameId;
    }
    // A later stop (or another re-registration) may have already superseded
    // this instance while we waited — do not start an instance nobody wants.
    if (host.instances.get(definition.id) !== instance) {
      return;
    }

    let cleanup: RendererServiceCleanup;
    try {
      cleanup = await definition.start({
        shell: host.shell,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // error-policy:J6 the instance was stopped while starting; a rejection
        // from the torn-down start is expected teardown noise, not a failure.
        return;
      }
      // The failed instance stays in the map so its state reads "failed", not
      // a healthy-looking absence (three-state rule: failure must be visible).
      instance.status = "failed";
      // error-policy:J1 host boundary — a service failing to start must not
      // take down the renderer boot path; it is surfaced via the reporter.
      host.reportError(definition.id, error, "start");
      return;
    }

    if (typeof cleanup !== "function") {
      instance.status = "failed";
      host.reportError(
        definition.id,
        new Error(
          `renderer service "${definition.id}" start() returned ${String(
            cleanup,
          )} instead of a cleanup function`,
        ),
        "start",
      );
      return;
    }

    if (controller.signal.aborted) {
      // Stopped while start was awaited: run the late cleanup now so no
      // listener/interval installed by the finished start survives the stop,
      // and await it so this instance's `settled` remains the single signal
      // a waiting successor needs.
      instance.cleanup = cleanup;
      await runCleanup(host, instance);
      return;
    }

    instance.cleanup = cleanup;
    instance.status = "running";
  })();
}

function isEligible(
  definition: RendererServiceDefinition,
  shell: RendererShellKind,
): boolean {
  return definition.shells.includes(shell);
}

/**
 * Register (or re-register) a renderer service definition. Plugin registration
 * entries call this at import time. If a host is active and the definition's
 * shells include the host's shell, the service starts immediately.
 * Re-registering an id replaces the definition: the old instance is stopped
 * (its cleanup runs, and is fully awaited before the replacement starts) —
 * this is what makes dev HMR of a plugin registration module safe even when
 * the old instance's cleanup is asynchronous.
 */
export function registerRendererService(
  definition: RendererServiceDefinition,
): void {
  if (!definition.id || definition.id.trim().length === 0) {
    throw new Error(`${LOG_PREFIX} a renderer service needs a non-empty id`);
  }
  if (definition.shells.length === 0) {
    throw new Error(
      `${LOG_PREFIX} service "${definition.id}" declares no shells; declare where it runs instead of registering it nowhere`,
    );
  }
  const store = getStore();
  store.definitions.set(definition.id, definition);

  const host = store.host;
  if (!host || host.disposed) return;
  const existing = host.instances.get(definition.id);
  if (existing) stopInstance(host, existing);
  if (isEligible(definition, host.shell)) startInstance(host, definition);
}

/**
 * Install the per-window service host. The app shell calls this once per
 * renderer window with the window's resolved shell kind; every already
 * registered eligible definition starts, later registrations start on
 * arrival. A non-bfcache `pagehide` (real page teardown, including mobile app
 * kill) disposes everything; a bfcache round trip (`persisted=true`) instead
 * suspends every instance — their cleanup runs, but the host and its
 * definitions survive — and a matching `pageshow` restarts them. Calling
 * again replaces the previous host: its disposal is awaited before any of the
 * new host's instances start, so a stale generation's in-flight teardown can
 * never land after (and clobber) the replacement.
 */
export function startRendererServiceHost(options: {
  shell: RendererShellKind;
  reportError?: RendererServiceErrorReporter;
}): RendererServiceHostHandle {
  const store = getStore();
  const priorDisposal = store.host ? disposeHost(store.host) : undefined;

  const host: HostState = {
    shell: options.shell,
    reportError: options.reportError ?? defaultReportError,
    instances: new Map(),
    pendingCleanup: new Map(),
    detachLifecycleHooks: null,
    disposed: false,
  };
  store.host = host;

  if (typeof window !== "undefined") {
    const onPagehide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // bfcache entry: suspend every instance's owned resources now — the
        // page can come back via pageshow, so the host and its definitions
        // must survive. The page may freeze mid-flight; only *initiating*
        // every instance's stop needs to be synchronous, which it is (each
        // stopInstance call below invokes cleanup() synchronously).
        for (const instance of [...host.instances.values()]) {
          stopInstance(host, instance);
        }
        return;
      }
      disposeHost(host);
    };
    const onPageshow = (event: PageTransitionEvent) => {
      if (!event.persisted || host.disposed) return;
      // Restore from bfcache: restart every eligible definition that isn't
      // already running through the same serialized start path, so a restart
      // racing a still-in-flight suspension cleanup waits for it.
      for (const definition of store.definitions.values()) {
        if (
          isEligible(definition, host.shell) &&
          !host.instances.has(definition.id)
        ) {
          startInstance(host, definition);
        }
      }
    };
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("pageshow", onPageshow);
    host.detachLifecycleHooks = () => {
      window.removeEventListener("pagehide", onPagehide);
      window.removeEventListener("pageshow", onPageshow);
    };
  }

  for (const definition of store.definitions.values()) {
    if (isEligible(definition, host.shell)) {
      startInstance(host, definition, priorDisposal);
    }
  }

  return {
    shell: host.shell,
    dispose: () => disposeHost(host),
  };
}

/**
 * Stop every instance and detach the lifecycle hooks. Returns a promise that
 * settles once every instance's cleanup has fully run (idempotent — a second
 * call resolves immediately). The next host generation's `startInstance`
 * calls await this so a replaced generation's in-flight teardown can never
 * land after the replacement starts.
 */
function disposeHost(host: HostState): Promise<void> {
  if (host.disposed) return Promise.resolve();
  host.disposed = true;
  host.detachLifecycleHooks?.();
  host.detachLifecycleHooks = null;
  const settling = [...host.instances.values()].map((instance) =>
    stopInstance(host, instance),
  );
  const store = getStore();
  if (store.host === host) store.host = null;
  return Promise.all(settling).then(() => undefined);
}

/**
 * Current registry snapshot for diagnostics and tests: every registered
 * definition with its lifecycle status under the active host (or
 * "registered"/"ineligible" when idle), plus the active host shell.
 */
export function getRendererServiceStates(): {
  hostShell: RendererShellKind | null;
  services: RendererServiceState[];
} {
  const store = getStore();
  const host = store.host && !store.host.disposed ? store.host : null;
  const services: RendererServiceState[] = [];
  for (const definition of store.definitions.values()) {
    const instance = host?.instances.get(definition.id);
    const status: RendererServiceStatus = instance
      ? instance.status
      : host
        ? isEligible(definition, host.shell)
          ? "stopped"
          : "ineligible"
        : "registered";
    services.push({ id: definition.id, shells: definition.shells, status });
  }
  return { hostShell: host?.shell ?? null, services };
}

/**
 * Wait until no registered instance is still mid-start. Diagnostics/tests
 * only — production callers never need to await service startup.
 */
export async function settleRendererServices(): Promise<void> {
  const host = getStore().host;
  if (!host) return;
  await Promise.all([...host.instances.values()].map((i) => i.settled));
}

/**
 * Drop every definition and stop the active host. Test isolation only — the
 * store is process-global, so suites that exercise registration must reset it
 * between cases.
 */
export function resetRendererServicesForTest(): void {
  const store = getStore();
  if (store.host) disposeHost(store.host);
  store.definitions.clear();
}
