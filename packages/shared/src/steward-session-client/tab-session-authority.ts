/**
 * Origin-wide Steward session-authority coordinator.
 *
 * Same-realm queues cannot order cookie or canonical-token mutations across
 * tabs. This module serializes those operations through one Web Lock, keeps a
 * durable logout generation that is never reset, and revalidates captured
 * token/generation before persistence, before cookie mutation, after response
 * settlement, and before publishing markers.
 */
export const STEWARD_LOGOUT_GENERATION_KEY =
  "steward_session_logout_generation";
export const STEWARD_SESSION_AUTHORITY_LOCK_NAME =
  "elizaos:steward-session-authority:v1";
export const STEWARD_SESSION_AUTHORITY_TIMEOUT_MS = 10_000;

export type StewardSessionAuthorityKind =
  | "session-sync"
  | "nonce-exchange"
  | "refresh"
  | "callback-restore"
  | "passive-mirror"
  | "logout"
  | "cookie-delete"
  | "token-write";

export type StewardSessionAuthorityErrorCode =
  | "STEWARD_SESSION_AUTHORITY_UNAVAILABLE"
  | "STEWARD_SESSION_AUTHORITY_SUPERSEDED"
  | "STEWARD_SESSION_AUTHORITY_TIMEOUT"
  | "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED";

export class StewardSessionAuthorityError extends Error {
  readonly code: StewardSessionAuthorityErrorCode;

  constructor(
    message: string,
    code: StewardSessionAuthorityErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StewardSessionAuthorityError";
    this.code = code;
  }
}

export interface StewardSessionAuthoritySnapshot {
  token: string | null;
  generation: string;
}

export interface StewardSessionAuthorityLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface StewardSessionAuthorityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StewardTabSessionAuthorityDependencies {
  storage?: StewardSessionAuthorityStorage | null;
  lockManager?: StewardSessionAuthorityLockManager | null;
  tokenKey?: string;
  now?: () => number;
  randomId?: () => string;
  timeoutMs?: number;
}

export interface StewardSessionAuthorityWorkContext {
  kind: StewardSessionAuthorityKind;
  signal: AbortSignal;
  snapshot: StewardSessionAuthoritySnapshot;
  revalidate: () => StewardSessionAuthoritySnapshot;
  noteToken: (token: string | null) => void;
  advanceLogoutGeneration: () => string;
  /**
   * Nested exclusive work on the current hold. Independent callers must use
   * the coordinator `runExclusive` so they serialize behind this callback
   * instead of borrowing ambient async state.
   */
  runExclusive: <U>(
    options: StewardSessionAuthorityRunOptions<U>,
  ) => Promise<U>;
}

export interface StewardSessionAuthorityRunOptions<T> {
  kind: StewardSessionAuthorityKind;
  expectedToken?: string | null;
  expectedGeneration?: string;
  requireTokenAbsent?: boolean;
  requireOriginWide?: boolean;
  timeoutMs?: number;
  work: (ctx: StewardSessionAuthorityWorkContext) => Promise<T>;
}

export interface StewardTabSessionAuthorityCoordinator {
  readonly originWide: boolean;
  readGeneration(): string;
  readSnapshot(): StewardSessionAuthoritySnapshot;
  runExclusive<T>(options: StewardSessionAuthorityRunOptions<T>): Promise<T>;
}

const EMPTY_GENERATION = "0:none";

function randomGenerationNonce(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function parseGeneration(raw: string | null): { seq: number; nonce: string } {
  if (!raw) return { seq: 0, nonce: "none" };
  const split = raw.indexOf(":");
  if (split <= 0) return { seq: 0, nonce: "none" };
  const seq = Number(raw.slice(0, split));
  const nonce = raw.slice(split + 1);
  if (!Number.isSafeInteger(seq) || seq < 0 || !nonce) {
    return { seq: 0, nonce: "none" };
  }
  return { seq, nonce };
}

function formatGeneration(seq: number, nonce: string): string {
  return `${seq}:${nonce}`;
}

function createFallbackLockManager(): StewardSessionAuthorityLockManager {
  let busy = false;
  const waiters: Array<{ aborted: boolean; run: () => void }> = [];

  const timeoutError = (): StewardSessionAuthorityError =>
    new StewardSessionAuthorityError(
      "Steward session authority timed out waiting for the origin lock.",
      "STEWARD_SESSION_AUTHORITY_TIMEOUT",
    );

  const dequeueNext = (): void => {
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (next && !next.aborted) {
        next.run();
        return;
      }
    }
    busy = false;
  };

  return {
    request<T>(
      _name: string,
      options: { mode: "exclusive"; signal: AbortSignal },
      callback: () => T | PromiseLike<T>,
    ): Promise<T> {
      const run = (): Promise<T> => {
        if (options.signal.aborted) {
          dequeueNext();
          return Promise.reject(timeoutError());
        }
        busy = true;
        try {
          return Promise.resolve(callback()).finally(() => {
            dequeueNext();
          });
        } catch (cause) {
          dequeueNext();
          return Promise.reject(cause);
        }
      };
      if (!busy) return run();
      return new Promise<T>((resolve, reject) => {
        const entry = {
          aborted: false,
          run: () => {
            options.signal.removeEventListener("abort", onAbort);
            run().then(resolve, reject);
          },
        };
        const onAbort = (): void => {
          entry.aborted = true;
          const index = waiters.indexOf(entry);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(timeoutError());
          }
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(entry);
      });
    },
  };
}

function resolveBrowserLockManager(): StewardSessionAuthorityLockManager | null {
  if (typeof navigator === "undefined") return null;
  try {
    if (globalThis.isSecureContext === false) return null;
    const browserLocks = navigator.locks;
    if (!browserLocks?.request) return null;
    return {
      request: (name, options, callback) =>
        browserLocks.request(name, options, callback),
    };
  } catch {
    // error-policy:J4 missing Web Locks is unavailability, not a thrown lock.
    return null;
  }
}

function resolveBrowserStorage(): StewardSessionAuthorityStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // error-policy:J4 storage access denial is unavailability.
    return null;
  }
}

export function isOriginWideStewardSessionAuthorityAvailable(): boolean {
  return (
    resolveBrowserLockManager() !== null && resolveBrowserStorage() !== null
  );
}

export function createStewardTabSessionAuthorityCoordinator(
  deps: StewardTabSessionAuthorityDependencies = {},
): StewardTabSessionAuthorityCoordinator {
  const tokenKey = deps.tokenKey ?? "steward_session_token";
  const timeoutMs = deps.timeoutMs ?? STEWARD_SESSION_AUTHORITY_TIMEOUT_MS;
  const getStorage = (): StewardSessionAuthorityStorage | null =>
    deps.storage === undefined ? resolveBrowserStorage() : deps.storage;
  const getOriginWideLocks = (): StewardSessionAuthorityLockManager | null =>
    deps.lockManager === undefined
      ? resolveBrowserLockManager()
      : deps.lockManager;
  const fallbackLocks = createFallbackLockManager();
  const getLocks = (): StewardSessionAuthorityLockManager =>
    getOriginWideLocks() ?? fallbackLocks;
  const isOriginWide = (): boolean =>
    getOriginWideLocks() !== null && getStorage() !== null;
  const randomId = deps.randomId ?? randomGenerationNonce;

  const readToken = (): string | null => {
    const storage = getStorage();
    if (!storage) return null;
    return storage.getItem(tokenKey);
  };

  const readGeneration = (): string => {
    const storage = getStorage();
    if (!storage) return EMPTY_GENERATION;
    try {
      const raw = storage.getItem(STEWARD_LOGOUT_GENERATION_KEY);
      const parsed = parseGeneration(raw);
      return formatGeneration(parsed.seq, parsed.nonce);
    } catch (cause) {
      throw new StewardSessionAuthorityError(
        "Could not read the Steward logout generation.",
        "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
        { cause },
      );
    }
  };

  const persistGeneration = (value: string): void => {
    const storage = getStorage();
    if (!storage) {
      throw new StewardSessionAuthorityError(
        "Steward logout generation storage is unavailable.",
        "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
      );
    }
    storage.setItem(STEWARD_LOGOUT_GENERATION_KEY, value);
    if (storage.getItem(STEWARD_LOGOUT_GENERATION_KEY) !== value) {
      throw new StewardSessionAuthorityError(
        "Steward logout generation did not round-trip through storage.",
        "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
      );
    }
  };

  const advanceLogoutGeneration = (): string => {
    const storage = getStorage();
    const current = parseGeneration(
      storage ? storage.getItem(STEWARD_LOGOUT_GENERATION_KEY) : null,
    );
    const next = formatGeneration(current.seq + 1, randomId());
    persistGeneration(next);
    return next;
  };

  const readSnapshot = (): StewardSessionAuthoritySnapshot => ({
    token: readToken(),
    generation: readGeneration(),
  });

  const assertExpectation = (expected: {
    generation: string;
    token?: string | null;
    requireTokenAbsent?: boolean;
  }): StewardSessionAuthoritySnapshot => {
    const current = readSnapshot();
    if (current.generation !== expected.generation) {
      throw new StewardSessionAuthorityError(
        "Steward session authority was superseded by a newer logout generation.",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
    }
    if (expected.requireTokenAbsent === true && current.token !== null) {
      throw new StewardSessionAuthorityError(
        "Steward cookie cleanup was superseded by a newer token.",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
    }
    if (expected.token !== undefined && current.token !== expected.token) {
      throw new StewardSessionAuthorityError(
        "Steward session authority was superseded by a different token.",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
    }
    return current;
  };

  async function runExclusive<T>(
    options: StewardSessionAuthorityRunOptions<T>,
  ): Promise<T> {
    if (options.requireOriginWide && !isOriginWide()) {
      throw new StewardSessionAuthorityError(
        "Origin-wide Steward session authority is unavailable.",
        "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
      );
    }

    const workTimeoutMs = options.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, workTimeoutMs);

    type CapturedExpectation = {
      generation: string;
      token?: string | null;
      requireTokenAbsent?: boolean;
    };

    const adoptSnapshot = (target: CapturedExpectation): void => {
      const snap = readSnapshot();
      target.generation = snap.generation;
      if (snap.token === null) {
        target.token = null;
        target.requireTokenAbsent = true;
      } else {
        target.token = snap.token;
        delete target.requireTokenAbsent;
      }
    };

    const runHeldWork = async <U>(
      held: StewardSessionAuthorityRunOptions<U>,
    ): Promise<U> => {
      if (held.requireOriginWide && !isOriginWide()) {
        throw new StewardSessionAuthorityError(
          "Origin-wide Steward session authority is unavailable.",
          "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
        );
      }
      const heldCaptured: CapturedExpectation = {
        generation: held.expectedGeneration ?? readGeneration(),
        ...(held.expectedToken !== undefined
          ? { token: held.expectedToken }
          : {}),
        ...(held.requireTokenAbsent ? { requireTokenAbsent: true } : {}),
      };
      if (controller.signal.aborted) {
        throw new StewardSessionAuthorityError(
          "Steward session authority timed out.",
          "STEWARD_SESSION_AUTHORITY_TIMEOUT",
        );
      }
      assertExpectation(heldCaptured);
      const ctx: StewardSessionAuthorityWorkContext = {
        kind: held.kind,
        signal: controller.signal,
        snapshot: readSnapshot(),
        revalidate: () => assertExpectation(heldCaptured),
        noteToken: (token) => {
          heldCaptured.token = token;
          if (token === null) heldCaptured.requireTokenAbsent = true;
          else delete heldCaptured.requireTokenAbsent;
        },
        advanceLogoutGeneration: () => {
          const next = advanceLogoutGeneration();
          heldCaptured.generation = next;
          return next;
        },
        runExclusive: async (nested) => {
          const result = await runHeldWork(nested);
          adoptSnapshot(heldCaptured);
          return result;
        },
      };
      const result = await held.work(ctx);
      assertExpectation(heldCaptured);
      return result;
    };

    try {
      const result = await getLocks().request(
        STEWARD_SESSION_AUTHORITY_LOCK_NAME,
        { mode: "exclusive", signal: controller.signal },
        async () => runHeldWork(options),
      );
      return result;
    } catch (cause) {
      if (cause instanceof StewardSessionAuthorityError) throw cause;
      if (controller.signal.aborted) {
        throw new StewardSessionAuthorityError(
          "Steward session authority timed out.",
          "STEWARD_SESSION_AUTHORITY_TIMEOUT",
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get originWide() {
      return isOriginWide();
    },
    readGeneration,
    readSnapshot,
    runExclusive,
  };
}

let defaultCoordinator: StewardTabSessionAuthorityCoordinator | null = null;

export function getStewardTabSessionAuthorityCoordinator(): StewardTabSessionAuthorityCoordinator {
  defaultCoordinator ??= createStewardTabSessionAuthorityCoordinator();
  return defaultCoordinator;
}

/** Test-only: replace the process-wide coordinator used by production wrappers. */
export function resetStewardTabSessionAuthorityCoordinatorForTests(
  coordinator?: StewardTabSessionAuthorityCoordinator | null,
): void {
  defaultCoordinator = coordinator ?? null;
}

export async function runStewardSessionAuthorityExclusive<T>(
  options: StewardSessionAuthorityRunOptions<T>,
): Promise<T> {
  return getStewardTabSessionAuthorityCoordinator().runExclusive(options);
}

export function isStewardSessionAuthoritySuperseded(error: unknown): boolean {
  return (
    error instanceof StewardSessionAuthorityError &&
    error.code === "STEWARD_SESSION_AUTHORITY_SUPERSEDED"
  );
}
