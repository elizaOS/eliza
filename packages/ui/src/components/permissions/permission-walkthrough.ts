/**
 * Startup permission walkthrough: the host-independent policy behind a first-run access panel
 * (an ordered list of soft-ask steps, one OS prompt per explicit tap) and its Settings reopen entry.
 *
 * Nothing here grants or claims platform access. Progress and memory are installation UI state
 * only; every step reads access back from the platform. A denial never schedules another prompt,
 * including after a restart, and moves the step to the system-settings path instead. Hosts supply
 * their installed storage keys, ordered key lists and bridges; no product identity lives here.
 */

/** Minimal synchronous storage (localStorage, sessionStorage or a test map). */
export type WalkthroughStore = Pick<Storage, "getItem" | "setItem">;

/** One step's platform bridge. `status` is the platform's own answer, read every time. */
export interface PermissionStepBridge {
  status(): Promise<{
    granted: boolean;
    enabled: boolean;
    denied?: boolean;
    requestable?: boolean;
  }>;
  request(): Promise<unknown>;
  openSettings(): Promise<unknown>;
}

export type PermissionStepState =
  | "checking"
  | "request"
  | "settings"
  | "ready"
  | "unavailable";

/** A photo-library answer: a selected or partial grant is useful access, never "the whole library". */
export function photoLibraryAccess(value: unknown): {
  granted: boolean;
  enabled: boolean;
  scope: "full" | "partial" | "selected" | "denied";
  description: string;
} {
  const row = value as { scope?: unknown; locked?: unknown } | null;
  if (
    !row ||
    typeof row.scope !== "string" ||
    !["full", "partial", "selected", "denied"].includes(row.scope) ||
    typeof row.locked !== "boolean" ||
    row.locked
  )
    throw Error("Photo access unavailable");
  const scope = row.scope as "full" | "partial" | "selected" | "denied";
  return {
    granted: scope !== "denied",
    enabled: scope !== "denied",
    scope,
    description:
      scope === "full"
        ? "All photos and videos allowed"
        : scope === "selected"
          ? "Selected photos and videos only"
          : scope === "partial"
            ? "Limited photo or video access allowed"
            : "Not allowed",
  };
}

/** Location permission metadata: approximate access is usable without claiming a precise fix. */
export function locationAccess(value: unknown): {
  granted: boolean;
  enabled: boolean;
  requestable: boolean;
  accuracy: "precise" | "approximate" | "none";
  description: string;
} {
  const row = value as { location?: unknown; accuracy?: unknown } | null;
  if (
    !row ||
    typeof row.location !== "string" ||
    !["granted", "denied", "prompt", "prompt-with-rationale"].includes(
      row.location,
    )
  )
    throw Error("Location access unavailable");
  const granted = row.location === "granted";
  if (
    granted
      ? typeof row.accuracy !== "string" ||
        !["precise", "approximate"].includes(row.accuracy)
      : row.accuracy !== "none"
  )
    throw Error("Location accuracy unavailable");
  const accuracy = row.accuracy as "precise" | "approximate" | "none";
  return {
    granted,
    enabled: granted,
    requestable: row.location !== "denied",
    accuracy,
    description: granted
      ? accuracy === "precise"
        ? "Precise location allowed"
        : "Approximate location allowed"
      : "Not allowed",
  };
}

/** A Capacitor-style permission string (granted/denied/prompt/prompt-with-rationale). */
export function permissionStateAccess(value: unknown): {
  granted: boolean;
  enabled: boolean;
  requestable: boolean;
} {
  if (
    typeof value !== "string" ||
    !["granted", "denied", "prompt", "prompt-with-rationale"].includes(value)
  )
    throw Error("Permission status unavailable");
  return {
    granted: value === "granted",
    enabled: value === "granted",
    requestable: value !== "denied",
  };
}

/** Non-secret walkthrough memory: the "Not now" dismissal and which OS prompts were already shown. */
export interface WalkthroughMemory {
  dismissed: boolean;
  attempted: Record<string, true>;
}

export interface WalkthroughMemoryStore {
  read(): WalkthroughMemory;
  /** Best effort: false when storage is unavailable (the session keeps its in-memory behaviour). */
  write(patch: Partial<WalkthroughMemory>): boolean;
  /** Settings' "set up access" entry: clears the dismissal and announces the reopen. Requests nothing. */
  reopen(): void;
}

const defaultStore = (): WalkthroughStore | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Memory under the host's installed key, with a reopen event the panel listens for. */
export function walkthroughMemory(
  key: string,
  reopenEvent: string,
  store: () => WalkthroughStore | null = defaultStore,
): WalkthroughMemoryStore {
  const read = (): WalkthroughMemory => {
    try {
      const value = JSON.parse(store()?.getItem(key) || "null");
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { dismissed: false, attempted: {} };
      const attempted: Record<string, true> = {};
      if (value.attempted && typeof value.attempted === "object")
        for (const [name, flag] of Object.entries(value.attempted))
          if (flag === true && /^[a-z]{1,32}$/.test(name))
            attempted[name] = true;
      return { dismissed: value.dismissed === true, attempted };
    } catch {
      return { dismissed: false, attempted: {} };
    }
  };
  const write = (patch: Partial<WalkthroughMemory>): boolean => {
    const current = read();
    const next = {
      dismissed: patch.dismissed ?? current.dismissed,
      attempted: { ...current.attempted, ...(patch.attempted || {}) },
    };
    try {
      const target = store();
      if (!target) return false;
      target.setItem(key, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };
  return {
    read,
    write,
    reopen() {
      write({ dismissed: false });
      try {
        globalThis.dispatchEvent?.(new Event(reopenEvent));
      } catch {
        // No window (tests, workers): the next mount reads the cleared dismissal.
      }
    },
  };
}

/**
 * One step's flow. Requests happen only from {@link enable} (an explicit tap); a step whose prompt
 * was already shown, here or before a restart under `attemptKey`, goes to system settings instead.
 */
export function createPermissionStepFlow(
  bridge: PermissionStepBridge,
  options: { attemptKey?: string; memory?: WalkthroughMemoryStore } = {},
) {
  let attempted =
    !!options.attemptKey &&
    options.memory?.read().attempted[options.attemptKey] === true;
  let pending: number | null = null;
  let state: PermissionStepState = "checking";
  let generation = 0;
  async function check(current: number): Promise<PermissionStepState | null> {
    try {
      const access = await bridge.status();
      if (current !== generation) return null;
      if (
        typeof access.granted !== "boolean" ||
        typeof access.enabled !== "boolean" ||
        (access.requestable !== undefined &&
          typeof access.requestable !== "boolean")
      )
        throw Error("Unavailable");
      state =
        access.granted && access.enabled
          ? "ready"
          : attempted ||
              access.granted ||
              access.denied ||
              access.requestable === false
            ? "settings"
            : "request";
    } catch {
      if (current !== generation) return null;
      state = "unavailable";
    }
    return state;
  }
  return {
    /** Reads access again. A resume check during an owned prompt never retires that prompt's read. */
    refresh: () =>
      pending !== null ? Promise.resolve(null) : check(++generation),
    /** Retires UI ownership (not the platform prompt): a late answer advances nothing. */
    cancel() {
      ++generation;
      pending = null;
    },
    async enable(): Promise<PermissionStepState | null> {
      if (pending !== null) return null;
      const current = ++generation;
      pending = current;
      try {
        // Recheck before acting: access may have changed while the panel was open.
        if ((await check(current)) === null || current !== generation)
          return null;
        if (state === "request") {
          attempted = true;
          if (options.attemptKey)
            options.memory?.write({
              attempted: { [options.attemptKey]: true },
            });
          await bridge.request();
        } else if (state === "settings") await bridge.openSettings();
        if (current !== generation) return null;
        return await check(current);
      } catch {
        if (current !== generation) return null;
        state = "unavailable";
        return state;
      } finally {
        if (pending === current) pending = null;
      }
    },
  };
}

export type WalkthroughChoice = "allowed" | "continued" | "skipped";
export interface WalkthroughProgress {
  version: number;
  status: "pending" | "completed";
  step: number;
  choices?: WalkthroughChoice[];
}

/**
 * Resumable walkthrough progress under the host's installed key. `versions` maps each progress
 * version a build ever wrote to its step count; `current` is the version this build writes. An
 * unfinished older run resumes on the current list; a completed one stays completed.
 */
export function walkthroughProgress(
  key: string,
  versions: Readonly<Record<number, number>>,
  current: number,
) {
  if (!(current in versions)) throw Error("Unknown walkthrough version");
  const read = (storage: Pick<Storage, "getItem">): WalkthroughProgress => {
    const raw = storage.getItem(key);
    if (raw === null) return { version: current, status: "pending", step: 0 };
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !["status,step,version", "choices,status,step,version"].includes(
        Object.keys(value).sort().join(","),
      )
    )
      throw Error("Setup progress is unavailable.");
    const progress = value as WalkthroughProgress;
    const count = versions[progress.version];
    if (
      count === undefined ||
      !Number.isInteger(progress.step) ||
      !["pending", "completed"].includes(progress.status) ||
      (progress.status === "pending" &&
        (progress.step < 0 || progress.step >= count)) ||
      (progress.status === "completed" && progress.step !== count) ||
      (progress.choices !== undefined &&
        (!Array.isArray(progress.choices) ||
          progress.choices.length !== progress.step ||
          progress.choices.some(
            (choice) => !["allowed", "continued", "skipped"].includes(choice),
          )))
    )
      throw Error("Setup progress is unavailable.");
    return {
      ...progress,
      version: progress.status === "pending" ? current : progress.version,
    };
  };
  return {
    read,
    /** Validates, writes and reads back; throws when the value cannot be durably kept. */
    write(
      storage: Pick<Storage, "getItem" | "setItem">,
      progress: WalkthroughProgress,
    ): void {
      const raw = JSON.stringify(progress);
      read({ getItem: () => raw });
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw)
        throw Error("Setup progress could not be saved.");
    },
  };
}

/**
 * Whether the "you're set up" completion popup may open: only once, for an account this setup
 * just created, and never over a resumed walkthrough. A returning sign-in finishes silently.
 */
export function showWalkthroughCompletion(input: {
  accountCreated: boolean | undefined;
  resumed: boolean;
}): boolean {
  return input.accountCreated === true && !input.resumed;
}
