/**
 * Foreground host for explicit local-first Google Calendar sync on a phone or
 * in a browser.
 *
 * The host keeps the owner's saved opt-in for one exact account, calendar,
 * agent and local source, serializes review/enable/sync/pause through
 * `CalendarSyncController` and reports plain status text. A pass runs only in
 * the foreground: after a local edit (debounced), on return to the foreground
 * and after an owner change. There is no polling and no background work. A
 * changed owner, Google selection or agent cancels the running pass and never
 * reuses the earlier opt-in; a device calendar's own sync opt-in (Android) is
 * withdrawn when a different owner appears.
 *
 * Host specifics (owner, settings storage, the device calendar gate, the local
 * source and its events) are injected. Browser-safe and DOM-free: no Node
 * built-ins and only erasable TypeScript.
 */
import {
  CalendarLinkedStore,
  type CalendarLinkStorage,
  type CalendarSyncBinding,
} from "./linked-store.ts";
import {
  type CalendarSyncContext,
  CalendarSyncController,
  type CalendarSyncControllerOptions,
  type CalendarSyncReport,
  type CalendarSyncReview,
} from "./sync-controller.ts";

/** The owner, Google calendar and agent a saved opt-in must still name. */
export type CalendarSyncTarget = {
  environment: CalendarSyncBinding["environment"];
  userId: string;
  organizationId: string;
  connectionId: string;
  calendarId: string;
  agentId: string;
};

/** The owner's saved opt-in. Installed records keep exactly these four fields. */
export type CalendarSyncSettings = {
  version: 1;
  scope: string;
  binding: CalendarSyncBinding;
  enabled: boolean;
};

/** Where the opt-in is saved. `edit` replaces the record atomically or throws. */
export interface CalendarSyncSettingsStore {
  read(): Promise<unknown | null>;
  edit(
    edit: (value: CalendarSyncSettings | null) => CalendarSyncSettings | null,
  ): Promise<void>;
}

/** The verified account and calendar names shown in a review. */
export type CalendarSyncDestination = { account: string; calendar: string };

/** A prepared context may name the verified destination the review shows. */
export type CalendarSyncPrepared = CalendarSyncContext & {
  destination?: CalendarSyncDestination;
};

/**
 * A device calendar whose own sync opt-in gates provider effects (for example
 * an Android CalendarProvider bridge). Hosts without one omit it.
 */
export interface CalendarSyncDeviceGate {
  /** Whether the device-side opt-in is still granted. */
  enabled(): Promise<boolean>;
  /** Grants the device-side opt-in while `current` holds, before the owner's preference is saved. */
  enable(current: () => boolean): Promise<void>;
  /** Withdraws the device-side opt-in. Links and checkpoints are kept. */
  pause(): Promise<void>;
  /** Stops device-side work in flight. */
  cancel(): void;
}

/** The local source a target currently syncs. */
export type CalendarSyncLocalSource = {
  revision: string;
  /** With a device gate: whether the device-side opt-in still holds for this source. */
  deviceEnabled?: boolean;
};

export interface CalendarSyncHostOptions {
  /**
   * Prepares the exact sync context. `interactive` is true only during an
   * explicit owner review, so a host may ask for a device permission then.
   */
  prepare(
    signal: AbortSignal,
    request: { interactive: boolean },
  ): Promise<CalendarSyncPrepared>;
  settings: CalendarSyncSettingsStore;
  /** The current target; throws an Error that tells the owner what to connect or choose. */
  target(): CalendarSyncTarget;
  /** A stable identity of the owner, Cloud session, selection and agent; "" when unavailable. */
  identity(): string;
  /** True while the host may run sync (visible and in the foreground). */
  foreground(): boolean;
  /** Reads the target's current local source. */
  source(
    target: CalendarSyncTarget,
    current: () => boolean,
  ): Promise<CalendarSyncLocalSource>;
  /** The checkpoint storage the prepared contexts use. */
  storage: CalendarLinkStorage;
  /** The device calendar gate in effect, read at each use; undefined without one. */
  device?: () => CalendarSyncDeviceGate | undefined;
  controller?: CalendarSyncControllerOptions;
  /** Called after this host saved a changed opt-in, for example to tell other views. */
  settingsWritten?(): void;
  /** Status after a review; product hosts may name their own events. */
  reviewMessage?(events: number): string;
  /** Delay after a local edit before a pass, in milliseconds. Defaults to 400. */
  localChangeDelayMs?: number;
}

export type CalendarSyncHostSnapshot = {
  status: string;
  running: boolean;
  enabled: boolean;
};

/** Wiring for a foreground host: call these from the host's own events. */
export interface CalendarSyncForeground {
  /** The owner, Google selection, Cloud session or agent may have changed. */
  ownerChanged(): void;
  /** A local event or the local source changed. */
  localChanged(): void;
  /** Visibility changed; reads `foreground()`. */
  visibilityChanged(): void;
  /** Another view of the same storage changed the opt-in. */
  settingsChangedElsewhere(): void;
  stop(): void;
}

export interface CalendarSyncHost {
  subscribe(listener: () => void): () => void;
  snapshot(): CalendarSyncHostSnapshot;
  /** Re-reads the saved opt-in for the current target. */
  settings(): Promise<void>;
  /** Provider event ids already linked to local events, so a read-only view hides those copies. */
  linkedProviderEvents(): Promise<Set<string>>;
  destination(): CalendarSyncDestination;
  review(): Promise<CalendarSyncReview>;
  enable(review: CalendarSyncReview): Promise<CalendarSyncReport>;
  sync(): Promise<CalendarSyncReport>;
  pause(): Promise<void>;
  cancel(): void;
  /** Runs one pass when the saved opt-in still names the current target. Never throws. */
  resume(): Promise<void>;
  /** Starts foreground scheduling and resumes once. */
  start(): CalendarSyncForeground;
}

const SETTINGS_FIELDS = "binding,enabled,scope,version";

/** The saved opt-in, or null when none was saved. A damaged record is neither on nor off. */
export function readCalendarSyncSettings(
  value: unknown,
): CalendarSyncSettings | null {
  if (value === null || value === undefined) return null;
  const row = value as Partial<CalendarSyncSettings>;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    row.version !== 1 ||
    typeof row.scope !== "string" ||
    !row.binding ||
    typeof row.binding !== "object" ||
    typeof row.enabled !== "boolean" ||
    Object.keys(value).sort().join() !== SETTINGS_FIELDS
  )
    throw Error(
      "Calendar sync settings need recovery. Saved events are retained.",
    );
  return row as CalendarSyncSettings;
}

/** Whether a saved binding still names this owner, Google calendar and agent. */
export function calendarSyncTargetMatches(
  binding: CalendarSyncBinding | undefined,
  target: CalendarSyncTarget,
): boolean {
  return (
    !!binding &&
    binding.environment === target.environment &&
    binding.userId === target.userId &&
    binding.organizationId === target.organizationId &&
    binding.connectionId === target.connectionId &&
    binding.calendarId === target.calendarId &&
    binding.agentId === target.agentId
  );
}

/** Opt-in settings in one compare-and-exchange slot (encrypted on a phone). */
export function calendarSyncSettingsSlot(
  storage: CalendarLinkStorage,
  slot: string,
  attempts = 8,
): CalendarSyncSettingsStore {
  return {
    read: () => storage.read(slot),
    async edit(edit) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const before = await storage.read(slot),
          after = edit(before as CalendarSyncSettings | null);
        const result = await storage.compareExchange(slot, before, after);
        if (result.status === "saved") return;
      }
      throw Error("Calendar sync settings changed. Review them again.");
    },
  };
}

/** Plain status text for a failed or stopped operation. */
export function calendarSyncFailureMessage(error: unknown): string {
  const e = error as { status?: number; name?: string; message?: string };
  if (e?.status === 404)
    return "Calendar sync is not available on this server yet. Check linked events before retrying.";
  if (e?.name === "AbortError")
    return "Sync paused or the selected account changed. Check linked events before retrying.";
  return (
    e?.message ||
    "Sync stopped. Check the selected Google calendar before retrying."
  );
}

/** Plain status text for a finished pass. Any conflict, unconfirmed or refused change asks for review. */
export function calendarSyncReportMessage(result: CalendarSyncReport): string {
  const warnings = result.conflicted + result.quarantined + result.dirty;
  return warnings
    ? `Sync needs review: ${result.conflicted} conflicts, ${result.quarantined} unconfirmed changes, ${result.dirty} refused changes.`
    : `Synced: ${result.pushed} sent to Google, ${result.pulled} received, ${result.clean} unchanged.${result.paused ? ` ${result.paused} links paused.` : ""}`;
}

export function createCalendarSyncHost(
  options: CalendarSyncHostOptions,
): CalendarSyncHost {
  const gate = () => options.device?.();
  const reviewMessage =
    options.reviewMessage ??
    ((events: number) => `Ready to link ${events} local events.`);
  let destination: CalendarSyncDestination = { account: "", calendar: "" };
  let preparedBinding: CalendarSyncBinding | null = null,
    status = "Sync is off.",
    running = false,
    enabled = false,
    interactive = false;
  const listeners = new Set<() => void>();
  const settledListeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const saved = async () =>
    readCalendarSyncSettings(await options.settings.read());

  const controller = new CalendarSyncController(
    async (signal) => {
      const context = await options.prepare(signal, { interactive });
      preparedBinding = { ...context.binding };
      if (context.destination) destination = { ...context.destination };
      return context;
    },
    {
      read: async (scope) => {
        const value = await saved();
        enabled =
          value?.scope === scope &&
          value.enabled === true &&
          (await (gate()?.enabled() ?? true));
        return enabled;
      },
      write: async (scope, nextEnabled) => {
        const binding = preparedBinding;
        if (!binding)
          throw Error("Review the Calendar sync destination again.");
        await options.settings.edit(() => ({
          version: 1,
          scope,
          binding: { ...binding },
          enabled: nextEnabled,
        }));
        options.settingsWritten?.();
        enabled = nextEnabled;
      },
    },
    options.controller,
  );

  async function work<T>(
    action: () => Promise<T>,
    success: (result: T) => string,
    progress: string,
  ): Promise<T> {
    if (running) throw Error("Calendar sync is already running.");
    running = true;
    status = progress;
    changed();
    try {
      const result = await action();
      status = success(result);
      return result;
    } catch (error) {
      status = calendarSyncFailureMessage(error);
      throw error;
    } finally {
      running = false;
      changed();
      for (const listener of [...settledListeners]) listener();
    }
  }

  const cancel = () => {
    controller.cancel();
    gate()?.cancel();
  };

  const host: CalendarSyncHost = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => ({ status, running, enabled }),
    async settings() {
      const config = await saved();
      try {
        const target = options.target(),
          binding = config?.binding;
        enabled =
          !!config?.enabled && calendarSyncTargetMatches(binding, target);
        if (enabled && gate()) {
          const key = options.identity();
          const local = await options.source(
            target,
            () => options.foreground() && options.identity() === key,
          );
          enabled =
            local.deviceEnabled === true &&
            local.revision === binding?.localSourceRevision;
          if (!enabled)
            status =
              "Device sync needs a new review. Saved events are retained.";
        }
      } catch {
        enabled = false;
      }
      changed();
    },
    async linkedProviderEvents() {
      const config = await saved();
      if (!config?.enabled) return new Set();
      const target = options.target(),
        binding = config.binding,
        key = options.identity();
      if (!calendarSyncTargetMatches(binding, target)) return new Set();
      const current = () => options.foreground() && options.identity() === key;
      const local = await options.source(target, current);
      if (local.revision !== binding.localSourceRevision) return new Set();
      const store = await CalendarLinkedStore.open(
        binding,
        current,
        options.storage,
        { idempotencyNamespace: options.controller?.idempotencyNamespace },
      );
      return new Set(
        (await store.list())
          .filter(
            (row) =>
              row.providerEventId &&
              (row.state === "clean" || row.state === "dirty"),
          )
          .map((row) => row.providerEventId as string),
      );
    },
    destination: () => ({ ...destination }),
    review: () =>
      work(
        async () => {
          interactive = true;
          try {
            return await controller.review();
          } finally {
            interactive = false;
          }
        },
        (review) => reviewMessage(review.events.length),
        "Reviewing calendar…",
      ),
    async enable(review) {
      await work(
        async () => {
          const device = gate();
          if (!device) {
            await controller.enable(review);
            return;
          }
          if (review.reviewIdentity !== options.identity())
            throw Error("Calendar account changed. Review sync again.");
          await device.enable(
            () =>
              options.foreground() &&
              review.reviewIdentity === options.identity(),
          );
          try {
            // The device opt-in is new; enable only what a fresh review still shows.
            const refreshed = await controller.review();
            await controller.enable(refreshed);
          } catch (error) {
            await device.pause();
            throw error;
          }
        },
        () => "Sync enabled.",
        "Enabling sync…",
      );
      return host.sync();
    },
    sync: () =>
      work(() => controller.sync(), calendarSyncReportMessage, "Syncing…"),
    async pause() {
      controller.cancel();
      await gate()?.pause();
      await options.settings.edit((value) =>
        value ? { ...value, enabled: false } : null,
      );
      options.settingsWritten?.();
      enabled = false;
      status = "Sync is off. Saved events and links are retained.";
      changed();
    },
    cancel,
    async resume() {
      if (running || !options.foreground()) return;
      try {
        const config = await saved();
        if (!config?.enabled) return;
        if (!calendarSyncTargetMatches(config.binding, options.target()))
          return;
        await host.sync();
      } catch (error) {
        status = calendarSyncFailureMessage(error);
        changed();
      }
    },
    start() {
      const delay = options.localChangeDelayMs ?? 400;
      let pendingLocalChange = false,
        stopped = false,
        key = options.identity(),
        timer: ReturnType<typeof setTimeout> | undefined;
      const ownerChanged = () => {
        if (stopped) return;
        const next = options.identity();
        if (next === key) return;
        const changedExistingOwner = !!key;
        key = next;
        cancel();
        const device = gate();
        if (device && changedExistingOwner) {
          enabled = false;
          void device.pause().catch(() => {
            status =
              "Device sync pause could not be confirmed. Check pending deletions.";
            changed();
          });
        }
        status = "Sync is off.";
        changed();
        void host.resume();
      };
      const localChanged = () => {
        if (stopped || !enabled || !options.foreground()) return;
        if (running) {
          pendingLocalChange = true;
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => void host.resume(), delay);
      };
      const settled = () => {
        if (!pendingLocalChange) return;
        pendingLocalChange = false;
        localChanged();
      };
      settledListeners.add(settled);
      void host.resume();
      return {
        ownerChanged,
        localChanged,
        visibilityChanged() {
          if (stopped) return;
          if (options.foreground()) {
            void host.resume();
            return;
          }
          clearTimeout(timer);
          cancel();
        },
        settingsChangedElsewhere() {
          if (stopped) return;
          cancel();
          status = "Sync settings changed in another view.";
          changed();
        },
        stop() {
          stopped = true;
          clearTimeout(timer);
          settledListeners.delete(settled);
          cancel();
        },
      };
    },
  };
  return host;
}
