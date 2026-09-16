/**
 * Origin-wide Steward session-authority coordinator.
 *
 * Same-realm queues cannot order cookie or canonical-token mutations across
 * tabs. This module serializes those operations through one Web Lock, keeps a
 * durable logout generation that is never reset, and revalidates captured
 * token/generation before persistence, before cookie mutation, after response
 * settlement, and before publishing markers.
 */
import { STEWARD_ACTIVE_SCOPE_KEY, STEWARD_TOKEN_KEY } from "./session-keys.js";
import { readCanonicalStewardToken } from "./token-reader.js";

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
  | "STEWARD_SESSION_AUTHORITY_CANCELLED"
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
  scope: string | null;
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
  /** Last synchronous token-write step; cancellation cannot undo its completed publication. */
  completeTokenWrite: (token: string, publish: () => void) => void;
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
  signal?: AbortSignal;
  expectedToken?: string | null;
  expectedGeneration?: string;
  expectedScope?: string | null;
  requireTokenAbsent?: boolean;
  requireOriginWide?: boolean;
  timeoutMs?: number;
  work: (ctx: StewardSessionAuthorityWorkContext) => Promise<T>;
}

export interface StewardTabSessionAuthorityCoordinator {
  readonly originWide: boolean;
  readGeneration(): string;
  readSnapshot(): StewardSessionAuthoritySnapshot;
  /** Read-only check before another provider step; mutations still need a lease. */
  assertSnapshot(snapshot: StewardSessionAuthoritySnapshot): void;
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
          if (index >= 0) waiters.splice(index, 1);
          // A pre-aborted waiter has not been enqueued yet, but its promise
          // must still settle. Otherwise the fallback queue strands its caller.
          reject(timeoutError());
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
  const tokenKey = deps.tokenKey ?? STEWARD_TOKEN_KEY;
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
    if (deps.storage === undefined && tokenKey === STEWARD_TOKEN_KEY) {
      return readCanonicalStewardToken();
    }
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
      // error-policy:J2 storage failure cannot be mistaken for successful logout.
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
    try {
      storage.setItem(STEWARD_LOGOUT_GENERATION_KEY, value);
      if (storage.getItem(STEWARD_LOGOUT_GENERATION_KEY) !== value) {
        throw new StewardSessionAuthorityError(
          "Steward logout generation did not round-trip through storage.",
          "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
        );
      }
    } catch (cause) {
      // error-policy:J2 callers must stop teardown when durable invalidation fails.
      if (cause instanceof StewardSessionAuthorityError) throw cause;
      throw new StewardSessionAuthorityError(
        "Could not persist the Steward logout generation.",
        "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
        { cause },
      );
    }
  };

  const advanceLogoutGeneration = (): string => {
    const current = parseGeneration(readGeneration());
    const next = formatGeneration(current.seq + 1, randomId());
    persistGeneration(next);
    return next;
  };

  const readSnapshot = (): StewardSessionAuthoritySnapshot => {
    try {
      return {
        token: readToken(),
        generation: readGeneration(),
        scope: getStorage()?.getItem(STEWARD_ACTIVE_SCOPE_KEY) ?? null,
      };
    } catch (cause) {
      if (cause instanceof StewardSessionAuthorityError) throw cause;
      throw new StewardSessionAuthorityError(
        "Could not read the Steward session authority.",
        "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
        { cause },
      );
    }
  };

  const assertExpectation = (expected: {
    generation: string;
    scope: string | null;
    token?: string | null;
    requireTokenAbsent?: boolean;
  }): StewardSessionAuthoritySnapshot => {
    const current = readSnapshot();
    if (current.scope !== expected.scope) {
      throw new StewardSessionAuthorityError(
        "Steward session authority was superseded by a different Cloud target.",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
    }
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
    // Queueing does not renew an operation's authority. An explicit logout is
    // the exception: it ends whichever session wins the preceding transaction.
    const invoked = readSnapshot();
    const capturedOptions = {
      ...options,
      expectedScope:
        options.expectedScope !== undefined
          ? options.expectedScope
          : invoked.scope,
      ...(options.kind !== "logout"
        ? {
            expectedGeneration:
              options.expectedGeneration ?? invoked.generation,
          }
        : {}),
    };
    if (options.requireOriginWide && !isOriginWide()) {
      throw new StewardSessionAuthorityError(
        "Origin-wide Steward session authority is unavailable.",
        "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
      );
    }

    const workTimeoutMs = options.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
    }, workTimeoutMs);

    const assertActive = (): void => {
      if (options.signal?.aborted) {
        throw new StewardSessionAuthorityError(
          "Steward session recovery was cancelled.",
          "STEWARD_SESSION_AUTHORITY_CANCELLED",
        );
      }
      if (controller.signal.aborted) {
        throw new StewardSessionAuthorityError(
          "Steward session authority timed out.",
          "STEWARD_SESSION_AUTHORITY_TIMEOUT",
        );
      }
    };

    type CapturedExpectation = {
      generation: string;
      scope: string | null;
      token?: string | null;
      requireTokenAbsent?: boolean;
    };

    const runHeldWork = async <U>(
      held: StewardSessionAuthorityRunOptions<U>,
      ancestors: CapturedExpectation[] = [],
      parentSignal: AbortSignal = controller.signal,
      assertParentActive: () => void = assertActive,
    ): Promise<U> => {
      if (held.requireOriginWide && !isOriginWide()) {
        throw new StewardSessionAuthorityError(
          "Origin-wide Steward session authority is unavailable.",
          "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
        );
      }
      const heldCaptured: CapturedExpectation = {
        generation: held.expectedGeneration ?? readGeneration(),
        scope:
          held.expectedScope !== undefined
            ? held.expectedScope
            : readSnapshot().scope,
        ...(held.expectedToken !== undefined
          ? { token: held.expectedToken }
          : {}),
        ...(held.requireTokenAbsent ? { requireTokenAbsent: true } : {}),
      };
      assertActive();
      assertExpectation(heldCaptured);
      let leaseOpen = true;
      let tokenWriteCompleted = false;
      const lease = new AbortController();
      const cancelLease = () => lease.abort();
      if (parentSignal.aborted || held.signal?.aborted) cancelLease();
      else {
        parentSignal.addEventListener("abort", cancelLease, { once: true });
        held.signal?.addEventListener("abort", cancelLease, { once: true });
      }
      // The outer transaction already owns its queue + network deadline.
      // A nested operation may tighten that deadline without cancelling the
      // parent's remaining teardown/recovery work when its caller aborts.
      const nestedTimer =
        ancestors.length > 0 && held.timeoutMs !== undefined
          ? setTimeout(cancelLease, held.timeoutMs)
          : undefined;
      const assertLeaseActive = () => {
        assertParentActive();
        if (!leaseOpen || tokenWriteCompleted || held.signal?.aborted) {
          throw new StewardSessionAuthorityError(
            "Steward session transaction is no longer active.",
            "STEWARD_SESSION_AUTHORITY_CANCELLED",
          );
        }
        if (lease.signal.aborted) {
          throw new StewardSessionAuthorityError(
            "Steward session operation timed out.",
            "STEWARD_SESSION_AUTHORITY_TIMEOUT",
          );
        }
      };
      const ctx: StewardSessionAuthorityWorkContext = {
        kind: held.kind,
        signal: lease.signal,
        snapshot: readSnapshot(),
        revalidate: () => {
          assertLeaseActive();
          return assertExpectation(heldCaptured);
        },
        noteToken: (token) => {
          assertLeaseActive();
          for (const expectation of [heldCaptured, ...ancestors]) {
            expectation.token = token;
            if (token === null) expectation.requireTokenAbsent = true;
            else delete expectation.requireTokenAbsent;
          }
        },
        completeTokenWrite: (token, publish) => {
          if (held.kind !== "token-write")
            throw new Error(
              "Only token-write work can complete token publication",
            );
          ctx.revalidate();
          publish();
          // No await or abort-sensitive check follows this synchronous durable
          // commit. Parent leases retain their own cancellation checks.
          for (const expectation of [heldCaptured, ...ancestors]) {
            expectation.token = token;
            delete expectation.requireTokenAbsent;
          }
          tokenWriteCompleted = true;
        },
        advanceLogoutGeneration: () => {
          ctx.revalidate();
          const next = advanceLogoutGeneration();
          for (const expectation of [heldCaptured, ...ancestors]) {
            expectation.generation = next;
          }
          return next;
        },
        runExclusive: async (nested) => {
          ctx.revalidate();
          // Propagate only mutations explicitly made by the held child, even
          // when later legacy cleanup rejects. Never adopt unrelated storage
          // changes from an ambient snapshot as new authority.
          return runHeldWork(
            nested,
            [heldCaptured, ...ancestors],
            lease.signal,
            assertLeaseActive,
          );
        },
      };
      try {
        assertLeaseActive();
        const result = await held.work(ctx);
        if (!tokenWriteCompleted) ctx.revalidate();
        return result;
      } catch (cause) {
        // error-policy:J2 retain the operation's cancellation/timeout identity
        // instead of exposing a transport-specific abort error.
        if (!tokenWriteCompleted) assertLeaseActive();
        throw cause;
      } finally {
        leaseOpen = false;
        lease.abort();
        if (nestedTimer !== undefined) clearTimeout(nestedTimer);
        parentSignal.removeEventListener("abort", cancelLease);
        held.signal?.removeEventListener("abort", cancelLease);
      }
    };

    try {
      const result = await getLocks().request(
        STEWARD_SESSION_AUTHORITY_LOCK_NAME,
        { mode: "exclusive", signal: controller.signal },
        async () => runHeldWork(capturedOptions),
      );
      return result;
    } catch (cause) {
      // The fallback lock reports an aborted acquisition generically. Preserve
      // the caller's explicit cancellation instead of relabeling it timeout.
      if (options.signal?.aborted) assertActive();
      if (cause instanceof StewardSessionAuthorityError) throw cause;
      if (controller.signal.aborted) {
        if (options.signal?.aborted) assertActive();
        throw new StewardSessionAuthorityError(
          "Steward session authority timed out.",
          "STEWARD_SESSION_AUTHORITY_TIMEOUT",
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    get originWide() {
      return isOriginWide();
    },
    readGeneration,
    readSnapshot,
    assertSnapshot: (snapshot) => {
      assertExpectation(snapshot);
    },
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
