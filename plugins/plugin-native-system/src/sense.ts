/** Shared image-listener wire policy. No function here enables or resumes capture. */
export const LISTENER_STATES = [
  "OFF",
  "PERMISSION_REQUIRED",
  "NOTIFICATIONS_REQUIRED",
  "STOPPED_AFTER_ERRORS",
  "STOPPED_INDICATOR_LOST",
  "PAUSED_OTHER_USER",
  "WAITING_FOR_UNLOCK",
  "SPEECH_UNAVAILABLE",
  "INDICATOR_UNAVAILABLE",
  "PAUSED_USER",
  "PAUSED_CALL",
  "PAUSED_MIC_IN_USE",
  "PAUSED_MIC_UNAVAILABLE",
  "PAUSED_DISPLAY_OFF",
  "PAUSED_FULLSCREEN",
  "PAUSED_SHADE",
  "PAUSED_TRANSITION",
  "LISTENING",
] as const;
export type ListenerState = (typeof LISTENER_STATES)[number];
export type ListenerStatus =
  | { available: false }
  | {
      available: true;
      state: ListenerState;
      label: string;
      consented: boolean;
      listening: boolean;
      microphoneOpen: boolean;
    };
/**
 * Who opened the assistant surface, as native recorded it from Android's caller identity:
 * `listener` (a wake from the same-signer image listener), `system` (an assistant gesture such as
 * press-and-hold power that the platform-signed system UI launched with its identity shared),
 * `power` (a press recorded or launch-authorized only by the host's native permission-protected
 * Power activity) or `assist` (any other launch, which only opens the assistant). Null when
 * nothing is pending.
 */
export type AssistantInvocation =
  | "listener"
  | "system"
  | "power"
  | "assist"
  | null;
export interface SensePlugin {
  status(): Promise<ListenerStatus>;
  pause(): Promise<ListenerStatus>;
  turnOff(): Promise<ListenerStatus>;
  openSettings(): Promise<{ opened: boolean }>;
  bindInvocationSession(options: {
    generation: number;
    bindingId: string;
    sessionKey: string | null;
  }): Promise<void>;
  /** Drop only the current owner's pending Power receipt when capture cannot start now. */
  discardProtectedPowerInvocation?(options: {
    generation: number;
    bindingId: string;
    sessionKey: string;
  }): Promise<void>;
  /** Consume only a native-created protected launch grant; this method cannot mint one. */
  claimProtectedPowerLaunch?(options: {
    generation: number;
    bindingId: string;
    sessionKey: string;
    accountRef: string;
  }): Promise<unknown>;
  discardProtectedPowerLaunch?(options: {
    generation: number;
    bindingId: string;
    sessionKey: string | null;
  }): Promise<void>;
  takeInvocation(options: {
    generation: number;
    bindingId: string;
    sessionKey: string;
  }): Promise<unknown>;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
export function parseListenerStatus(raw: unknown): ListenerStatus {
  const value = record(raw);
  if (value.available !== true) return { available: false };
  const state = LISTENER_STATES.find((candidate) => candidate === value.state);
  if (!state) return { available: false };
  return {
    available: true,
    state,
    label:
      typeof value.label === "string" &&
      value.label.length > 0 &&
      value.label.length <= 80
        ? value.label
        : "Listening off",
    consented: value.consented === true,
    listening: state === "LISTENING" && value.listening === true,
    microphoneOpen: value.microphoneOpen === true,
  };
}
export function parseAssistantInvocation(raw: unknown): AssistantInvocation {
  const value = record(raw);
  if (value.assistant !== true) return null;
  return value.invocation === "listener" ||
    value.invocation === "system" ||
    value.invocation === "power"
    ? value.invocation
    : "assist";
}
export function parseInvocationUnlocked(raw: unknown): boolean {
  return record(raw).locked === false;
}
/**
 * A native voice origin (a listener wake, a system assistant gesture or a protected Power press)
 * starts one voice turn only while unlocked, visible, without a dialog or connection prompt, and
 * with no voice already active.
 */
export function listenerStartsVoice(input: {
  invocation: AssistantInvocation;
  unlocked: boolean;
  hidden: boolean;
  dialogOpen: boolean;
  connectionOpen: boolean;
  voiceActive: boolean;
}): boolean {
  return (
    (input.invocation === "listener" ||
      input.invocation === "system" ||
      input.invocation === "power") &&
    input.unlocked &&
    !input.hidden &&
    !input.dialogOpen &&
    !input.connectionOpen &&
    !input.voiceActive
  );
}

export const SENSE_INVOCATION_EVENT = "eliza:sense-invocation";
export const SENSE_MODAL_SELECTOR =
  'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]';
export interface SenseInvocationHost {
  /** Opaque authenticated owner/agent/session tuple. Never include bearer or credential values. */
  authority(): string | null;
  ready(): boolean;
  /** True only during automatic initial restoration, never interactive authentication. */
  initialRestorePending?(): boolean;
  /** Canonical noncredential verified account identity, matched against native launch admission. */
  powerAccountRef?(): string | null;
  voiceActive(): boolean;
  startVoice(): void;
  subscribe?(changed: () => void): () => void;
  events?: string[];
}
/** The native session key is an in-memory digest, not an authentication credential. */
export async function invocationSessionKey(authority: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(authority),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// All instances in this renderer share the bridge completion order. In particular,
// an old in-flight bind must finish before a replacement posts its new binding.
// Native methods resolve only after applying their mutation; no dispatch FIFO is assumed.
let invocationOperation = Promise.resolve();
let activeInvocationBinding: string | null = null;
let nextInvocationGeneration = 0;
export const SENSE_BRIDGE_TIMEOUT_MS = 10_000;
function serializeInvocation<T>(run: () => Promise<T>): Promise<T> {
  const bounded = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Sense bridge did not complete")),
            SENSE_BRIDGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const result = invocationOperation.then(bounded, bounded);
  invocationOperation = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Bind before consuming. Cold-start, changed-owner and stale async results cannot open the mic. */
export function createSenseInvocationController(
  native: Pick<
    SensePlugin,
    | "bindInvocationSession"
    | "takeInvocation"
    | "discardProtectedPowerInvocation"
    | "claimProtectedPowerLaunch"
    | "discardProtectedPowerLaunch"
  >,
  host: SenseInvocationHost,
) {
  const bindingId = crypto.randomUUID();
  const generation = ++nextInvocationGeneration;
  activeInvocationBinding = bindingId;
  let digestAuthority: string | null | undefined;
  let digestKey: string | null = null;
  let disposed = false,
    checking = false,
    dirty = false,
    initialized = false,
    bound: string | null = null;
  let coldLaunchAttempted = false;
  const current = (authority: string | null) =>
    !disposed &&
    activeInvocationBinding === bindingId &&
    host.authority() === authority;
  const check = async () => {
    if (disposed) return;
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    try {
      const authority = host.authority();
      const key =
        authority === digestAuthority
          ? digestKey
          : authority === null
            ? null
            : await invocationSessionKey(authority);
      if (!current(authority)) return;
      digestAuthority = authority;
      digestKey = key;
      if (!initialized || bound !== key) {
        await serializeInvocation(async () => {
          if (current(authority))
            await native.bindInvocationSession({
              generation,
              bindingId,
              sessionKey: key,
            });
        });
        if (!current(authority)) return;
        bound = key;
        initialized = true;
      }
      const initialRestore = host.initialRestorePending?.() === true;
      const blocked =
        document.hidden ||
        host.voiceActive() ||
        !!document.querySelector(SENSE_MODAL_SELECTOR);
      if (blocked || (!initialRestore && (key === null || !host.ready()))) {
        coldLaunchAttempted = true;
        await serializeInvocation(async () => {
          if (current(authority))
            await native.discardProtectedPowerLaunch?.({
              generation,
              bindingId,
              sessionKey: key,
            });
        });
      }
      if (key === null) return;
      if (
        document.hidden ||
        !host.ready() ||
        host.voiceActive() ||
        document.querySelector(SENSE_MODAL_SELECTOR)
      ) {
        await serializeInvocation(async () => {
          if (current(authority))
            await native.discardProtectedPowerInvocation?.({
              generation,
              bindingId,
              sessionKey: key,
            });
        });
        return;
      }
      const accountRef = host.powerAccountRef?.() ?? null;
      const receipt = await serializeInvocation(async () => {
        if (!current(authority)) return undefined;
        if (!initialRestore && !coldLaunchAttempted && host.powerAccountRef) {
          coldLaunchAttempted = true;
          const launch =
            accountRef === null
              ? undefined
              : await native.claimProtectedPowerLaunch?.({
                  generation,
                  bindingId,
                  sessionKey: key,
                  accountRef,
                });
          if (parseAssistantInvocation(launch) === "power") return launch;
        }
        return current(authority)
          ? native.takeInvocation({ generation, bindingId, sessionKey: key })
          : undefined;
      });
      if (
        !current(authority) ||
        !host.ready() ||
        host.voiceActive() ||
        (host.powerAccountRef && host.powerAccountRef() !== accountRef)
      )
        return;
      if (
        listenerStartsVoice({
          invocation: parseAssistantInvocation(receipt),
          unlocked: parseInvocationUnlocked(receipt),
          hidden: document.hidden,
          dialogOpen: !!document.querySelector(SENSE_MODAL_SELECTOR),
          connectionOpen: !host.ready(),
          voiceActive: host.voiceActive(),
        })
      )
        host.startVoice();
    } catch {
      /* Unavailable bridge, owner or crypto support cannot authorize capture. */
    } finally {
      checking = false;
      if (dirty && !disposed) {
        dirty = false;
        void check();
      }
    }
  };
  const changed = () => {
    void check();
  };
  const events = [SENSE_INVOCATION_EVENT, ...(host.events ?? [])];
  for (const event of events) window.addEventListener(event, changed);
  document.addEventListener("visibilitychange", changed);
  const unsubscribe = host.subscribe?.(changed);
  let attempts = 0;
  const initial = setInterval(() => {
    changed();
    if (++attempts >= 50) clearInterval(initial);
  }, 100);
  changed();
  return {
    check: changed,
    dispose() {
      disposed = true;
      if (activeInvocationBinding === bindingId) activeInvocationBinding = null;
      clearInterval(initial);
      unsubscribe?.();
      for (const event of events) window.removeEventListener(event, changed);
      document.removeEventListener("visibilitychange", changed);
      void serializeInvocation(async () => {
        await native.discardProtectedPowerLaunch?.({
          generation,
          bindingId,
          sessionKey: bound,
        });
        await native.bindInvocationSession({
          generation,
          bindingId,
          sessionKey: null,
        });
      }).catch(() => {});
    },
  };
}
