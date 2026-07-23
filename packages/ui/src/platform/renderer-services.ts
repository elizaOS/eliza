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
 * The store lives on `globalThis` so duplicated module evaluations (HMR, mixed
 * chunk graphs) share one registry — two copies of this module must never each
 * believe they own the running instances. Stop is race-safe against pending
 * starts: stopping while `start` is still awaited marks the instance stopped,
 * and the settled start's cleanup runs immediately instead of leaking. A
 * `start` that resolves without a cleanup function is a contract violation and
 * is reported as a failure — silently discarded disposers are exactly the bug
 * this module exists to prevent (#16504).
 */

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
  | "model-tester"
  | "embed";

/** Passed to a service `start`; `signal` aborts when this instance is stopped. */
export interface RendererServiceContext {
  shell: RendererShellKind;
  signal: AbortSignal;
}

export type RendererServiceCleanup = () => void;

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
  /** Stop every running/starting instance and detach the pagehide hook. */
  dispose: () => void;
}

interface ServiceInstance {
  definition: RendererServiceDefinition;
  controller: AbortController;
  status: "starting" | "running" | "failed" | "stopped";
  cleanup: RendererServiceCleanup | null;
  /** Settles when a pending start has fully resolved its cleanup handling. */
  settled: Promise<void>;
}

interface HostState {
  shell: RendererShellKind;
  reportError: RendererServiceErrorReporter;
  instances: Map<string, ServiceInstance>;
  detachPagehide: (() => void) | null;
  disposed: boolean;
}

interface RendererServiceStore {
  definitions: Map<string, RendererServiceDefinition>;
  host: HostState | null;
}

// Symbol.for so every copy of this module resolves the same store.
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
  console.error(`${LOG_PREFIX} service "${serviceId}" ${phase} failed:`, error);
};

function runCleanup(host: HostState, instance: ServiceInstance): void {
  const cleanup = instance.cleanup;
  instance.cleanup = null;
  if (!cleanup) return;
  try {
    cleanup();
  } catch (error) {
    // error-policy:J6 best-effort teardown — a throwing cleanup must not block
    // the remaining services' teardown; it is reported, never swallowed.
    host.reportError(instance.definition.id, error, "cleanup");
  }
}

function stopInstance(host: HostState, instance: ServiceInstance): void {
  if (instance.status === "stopped") return;
  const id = instance.definition.id;
  instance.status = "stopped";
  instance.controller.abort();
  // If start is still pending, cleanup is null here; the start continuation in
  // startInstance sees the aborted signal and runs the late cleanup itself.
  runCleanup(host, instance);
  host.instances.delete(id);
}

function startInstance(
  host: HostState,
  definition: RendererServiceDefinition,
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
      // listener/interval installed by the finished start survives the stop.
      instance.cleanup = cleanup;
      runCleanup(host, instance);
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
 * (its cleanup runs) before the new definition starts — this is what makes dev
 * HMR of a plugin registration module safe.
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
 * registered eligible definition starts, later registrations start on arrival,
 * and `pagehide` (page teardown, including mobile app kill) disposes
 * everything. Calling again replaces the previous host — its instances are
 * stopped first — which keeps repeated boots (tests, HMR of the shell) from
 * stacking duplicate instances.
 */
export function startRendererServiceHost(options: {
  shell: RendererShellKind;
  reportError?: RendererServiceErrorReporter;
}): RendererServiceHostHandle {
  const store = getStore();
  if (store.host) disposeHost(store.host);

  const host: HostState = {
    shell: options.shell,
    reportError: options.reportError ?? defaultReportError,
    instances: new Map(),
    detachPagehide: null,
    disposed: false,
  };
  store.host = host;

  if (typeof window !== "undefined") {
    const onPagehide = () => disposeHost(host);
    window.addEventListener("pagehide", onPagehide);
    host.detachPagehide = () =>
      window.removeEventListener("pagehide", onPagehide);
  }

  for (const definition of store.definitions.values()) {
    if (isEligible(definition, host.shell)) startInstance(host, definition);
  }

  return {
    shell: host.shell,
    dispose: () => disposeHost(host),
  };
}

function disposeHost(host: HostState): void {
  if (host.disposed) return;
  host.disposed = true;
  host.detachPagehide?.();
  host.detachPagehide = null;
  for (const instance of [...host.instances.values()]) {
    stopInstance(host, instance);
  }
  const store = getStore();
  if (store.host === host) store.host = null;
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
