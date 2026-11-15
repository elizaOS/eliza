type Activation = { activationId: string; bridgeId: string };
type StartupPort = {
  updateState(): Promise<unknown>;
  activateUpdate(
    input: Activation & { ready: boolean; resumeEligible?: true },
  ): Promise<unknown>;
  continueUpdate(input: Activation): Promise<unknown>;
};
type UpdateOutcome = "canceled" | "failed" | "installed";
export type AppUpdatePresentation = {
  dialogClass: string;
  dialogLabel: string;
  pendingLabel: string;
  continueLabel: string;
  navigationEvents: readonly string[];
};
type LivePort = StartupPort & {
  addListener(
    event: "alphaUpdateReady",
    listener: (value: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
};
type Pending = Activation & {
  phase: "preparing" | "paused";
  canContinue: boolean;
  automatic: boolean;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identity = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
const waitForReadback = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1000));
const outcome = (value: unknown): value is UpdateOutcome =>
  value === "canceled" || value === "failed" || value === "installed";

function preparation(value: unknown): Pending | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("bridgeId" in value) ||
    !identity(value.bridgeId) ||
    !("activationId" in value) ||
    !identity(value.activationId) ||
    !("phase" in value) ||
    (value.phase !== "preparing" && value.phase !== "paused")
  )
    return;
  return {
    activationId: value.activationId,
    bridgeId: value.bridgeId,
    phase: value.phase,
    automatic: "automatic" in value && value.automatic === true,
    canContinue:
      value.phase === "paused" &&
      "canContinue" in value &&
      value.canContinue === true,
  };
}

/** Bundled older hosts have no update journal. An advertised journal must answer. */
export function supportsAppUpdateStartup(
  headers: unknown,
  pluginName: string,
): boolean {
  return (
    Array.isArray(headers) &&
    headers.some(
      (header) =>
        header?.name === pluginName &&
        Array.isArray(header.methods) &&
        header.methods.some(
          (method: { name?: unknown }) => method?.name === "updateState",
        ),
    )
  );
}

/** A newly created WebView has no mounted editors. It can acknowledge its own
 * preparation, then hold the mount until the installer no longer owns a pause. */
export async function waitForAppUpdateStartup(
  port: Pick<StartupPort, "updateState" | "activateUpdate">,
  wait = waitForReadback,
  confirmation?: (pending: Activation | undefined) => void,
): Promise<void> {
  let pending: Activation | undefined;
  let acknowledged: string | undefined;
  for (;;) {
    const state = await port.updateState().catch(() => undefined);
    let resumable: Activation | undefined;
    if (
      state &&
      typeof state === "object" &&
      "bridgeId" in state &&
      identity(state.bridgeId)
    ) {
      if ("pending" in state && state.pending === false) {
        if (
          !pending ||
          (state.bridgeId === pending.bridgeId &&
            (("idle" in state && state.idle === true) ||
              ("activationId" in state &&
                state.activationId === pending.activationId &&
                "outcome" in state &&
                outcome(state.outcome))))
        )
          return;
      }
      const next =
        "pending" in state && state.pending === true
          ? preparation(state)
          : undefined;
      if (next && (!pending || pending.bridgeId === next.bridgeId)) {
        pending = { activationId: next.activationId, bridgeId: next.bridgeId };
        if (next.canContinue) resumable = pending;
        if (
          next.phase === "preparing" &&
          acknowledged !== pending.activationId
        ) {
          acknowledged = pending.activationId;
          // A late readiness can be rejected after seal or cancellation. Read
          // the exact native state again, without replaying this acknowledgment.
          await port
            .activateUpdate({ ...pending, ready: true })
            .catch(() => {});
        }
      }
    }
    confirmation?.(resumable);
    await wait();
  }
}

function updatePanel(port: StartupPort, appearance: AppUpdatePresentation) {
  const panel = document.createElement("dialog");
  panel.className = appearance.dialogClass;
  panel.setAttribute("aria-label", appearance.dialogLabel);
  panel.addEventListener("cancel", (event) => event.preventDefault());
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.textContent = appearance.pendingLabel;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = appearance.continueLabel;
  panel.append(status, button);
  let current: Activation | undefined;
  button.onclick = async () => {
    if (!current || button.disabled) return;
    button.disabled = true;
    try {
      await port.continueUpdate(current);
    } catch {
      /* Read the exact native state again. */
    } finally {
      button.disabled = false;
    }
  };
  return {
    show(activation?: Activation) {
      current = activation;
      button.hidden = !current;
      if (panel.open) return;
      document.body.append(panel);
      try {
        panel.showModal();
      } catch (error) {
        panel.remove();
        throw error;
      }
    },
    close() {
      current = undefined;
      panel.close();
      panel.remove();
    },
  };
}

/** Keep the Android confirmation reachable without starting any draft owner. */
export async function holdAppUpdateStartup(
  port: StartupPort,
  appearance: AppUpdatePresentation,
): Promise<void> {
  const panel = updatePanel(port, appearance);
  try {
    await waitForAppUpdateStartup(port, undefined, (activation) =>
      panel.show(activation),
    );
  } finally {
    panel.close();
  }
}

/** The installed page keeps its editors mounted, freezes input and verifies
 * its own draft owners before it acknowledges Android's exact activation. */
export async function watchMountedAppUpdates(
  port: LivePort,
  appearance: AppUpdatePresentation,
  prepare: (
    current: () => boolean,
    automatic?: boolean,
    editingAtFreeze?: boolean,
  ) => Promise<(stillSettled: () => boolean) => Promise<void>>,
  refused: () => void,
): Promise<void> {
  const panel = updatePanel(port, appearance);
  let active: Pending | undefined;
  let acknowledged: string | undefined;
  let reconnect: ((stillSettled: () => boolean) => Promise<void>) | undefined;
  let localRefusal = false;
  let checking = false;
  let notified = false;
  let editingAtFreeze = false;
  const editing = () => {
    const element = document.activeElement;
    return (
      element instanceof HTMLElement &&
      (element.matches("input,textarea") || element.isContentEditable)
    );
  };
  const stopNavigation = (event: Event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const event of appearance.navigationEvents)
    window.addEventListener(event, stopNavigation, true);

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      do {
        notified = false;
        const value = await port.updateState().catch(() => undefined);
        if (value && typeof value === "object" && "pending" in value) {
          const next = value.pending === true ? preparation(value) : undefined;
          if (next && (!active || active.bridgeId === next.bridgeId)) {
            if (!active || active.activationId !== next.activationId)
              editingAtFreeze = editing();
            active = next;
            const binding = {
              activationId: next.activationId,
              bridgeId: next.bridgeId,
            };
            let frozen = true;
            try {
              panel.show(next.canContinue ? binding : undefined);
            } catch {
              frozen = false;
            }
            if (
              next.phase === "preparing" &&
              acknowledged !== next.activationId
            ) {
              acknowledged = next.activationId;
              reconnect = undefined;
              localRefusal = false;
              const current = () =>
                active?.activationId === binding.activationId &&
                active.bridgeId === binding.bridgeId &&
                active.phase === "preparing";
              // Do not wait on a stalled editor before observing Android cancel the activation.
              const ready = frozen
                ? Promise.resolve()
                    .then(() =>
                      prepare(current, next.automatic, editingAtFreeze),
                    )
                    .catch(() => undefined)
                : Promise.resolve(undefined);
              void ready.then(async (prepared) => {
                if (!current()) return;
                reconnect = prepared;
                localRefusal = !prepared;
                await port
                  .activateUpdate({
                    ...binding,
                    ready: !!prepared,
                    ...(prepared ? { resumeEligible: true } : {}),
                  })
                  .catch(() => {});
              });
            }
          } else if (
            active &&
            value.pending === false &&
            "bridgeId" in value &&
            value.bridgeId === active.bridgeId
          ) {
            const ended = active.activationId;
            const terminal =
              "activationId" in value &&
              value.activationId === ended &&
              "outcome" in value &&
              outcome(value.outcome)
                ? value.outcome
                : undefined;
            // A newer result can replace this activation's terminal receipt while
            // the page is suspended. Native idle releases input, never a reconnect.
            if (terminal || ("idle" in value && value.idle === true)) {
              const matching = acknowledged === ended;
              const restart =
                matching &&
                terminal === "canceled" &&
                "resume" in value &&
                value.resume === true
                  ? reconnect
                  : undefined;
              const explain =
                matching &&
                terminal === "failed" &&
                localRefusal &&
                !active.automatic;
              active = undefined;
              reconnect = undefined;
              localRefusal = false;
              panel.close();
              if (explain) refused();
              if (restart)
                void restart(
                  () => !active && !notified && acknowledged === ended,
                );
            }
          }
        }
        if (active && !notified) await waitForReadback();
      } while (active || notified);
    } finally {
      checking = false;
    }
  };
  await port.addListener("alphaUpdateReady", (value) => {
    const pending = preparation(value);
    if (!pending) return;
    if (!active) {
      editingAtFreeze = editing();
      active = pending;
      try {
        panel.show();
      } catch {
        /* A failed modal blocks acknowledgment below. */
      }
    }
    notified = true;
    void check();
  });
  // The read covers an event emitted before subscription was installed.
  void check();
}

export type AppUpdateSchedule = {
  active: boolean;
  disposed: boolean;
  busy: boolean;
  failures: number;
  wakeAt: number;
};

/** Foreground upkeep. Native owns package admission, draft receipts and installation.
 * A suspended/disposed owner cannot start a later effect after an awaited read.
 * Never overlap a still-running native call, even across background/resume.
 */
export function createAppUpdateScheduler(options: {
  run(current: () => boolean): Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  intervalMs?: number;
  retryMs?: number;
}) {
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel =
    options.cancel ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const interval = options.intervalMs ?? 15 * 60 * 1000;
  const retry = options.retryMs ?? 60 * 1000;
  if (
    !Number.isSafeInteger(interval) ||
    interval <= 0 ||
    interval > 2_147_483_647 ||
    !Number.isSafeInteger(retry) ||
    retry <= 0 ||
    retry > interval
  )
    throw Error("Invalid app update schedule");
  let state: AppUpdateSchedule = {
    active: false,
    disposed: false,
    busy: false,
    failures: 0,
    wakeAt: 0,
  };
  let timer: unknown;
  let generation = 0;
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    if (!state.active || state.disposed || state.busy) return;
    timer = schedule(
      () => {
        timer = undefined;
        void poll();
      },
      Math.max(0, state.wakeAt - now()),
    );
  };
  async function poll() {
    if (!state.active || state.disposed || state.busy) return;
    if (now() < state.wakeAt) {
      arm();
      return;
    }
    clear();
    state = { ...state, busy: true };
    const owner = generation;
    const current = () =>
      !state.disposed && state.active && owner === generation;
    let failed = false;
    try {
      await options.run(current);
    } catch {
      failed = true;
    }
    const failures = failed ? Math.min(state.failures + 1, 20) : 0;
    state = {
      ...state,
      busy: false,
      failures,
      wakeAt:
        owner !== generation
          ? now()
          : now() +
            (failed
              ? Math.min(interval, retry * 2 ** (failures - 1))
              : interval),
    };
    arm();
  }
  return {
    snapshot: (): AppUpdateSchedule => ({ ...state }),
    setActive(active: boolean) {
      if (state.disposed) return;
      if (state.active !== active) generation++;
      state = { ...state, active };
      if (active) arm();
      else clear();
    },
    dispose() {
      generation++;
      state = { ...state, active: false, disposed: true };
      clear();
    },
  };
}
