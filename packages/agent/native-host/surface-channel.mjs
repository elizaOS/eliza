import { randomUUID } from "node:crypto";

export const SURFACE_CHANNEL_PATHS = new Set([
  "/browser/surface/connect",
  "/browser/surface/pull",
  "/browser/surface/reply",
  "/browser/surface/close",
]);
export const SURFACE_CHANNEL_BYTES = 2 * 1024 * 1024;
export class SurfaceChannelError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "SurfaceChannelError";
    this.code = code;
    this.status = status;
  }
}
const failure = (code, message, status = 409) =>
  new SurfaceChannelError(code, message, status);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const object = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const copy = (value) => {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > SURFACE_CHANNEL_BYTES)
    throw failure(
      "INVALID_REQUEST",
      "Surface message exceeds its explicit size limit",
      413,
    );
  return JSON.parse(encoded);
};

/**
 * One trusted renderer connection to an account-bound host. This is transport,
 * not a task store or task authorizer. Hosts must authorize every command and
 * native clients must enforce page/document/visibility and task policy again.
 * Pull consumes delivery before sending its HTTP reply: a lost reply never
 * causes an effect to be delivered twice.
 */
export function createSurfaceCommandChannel({
  credentialGate,
  timeoutMs = 10000,
  now = Date.now,
} = {}) {
  if (
    typeof credentialGate !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new TypeError(
      "A credential gate and bounded command deadline are required",
    );
  let session = null,
    highestEpoch = -1,
    closed = false;
  const pending = new Map();
  const retired = (entry) =>
    failure(
      entry.delivered && entry.effect ? "UNCERTAIN_OUTCOME" : "STALE_REF",
      "Surface command context ended; observe before continuing",
    );
  const settle = (entry, error, result) => {
    if (!pending.delete(entry.id)) return;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    if (error) entry.reject(error);
    else entry.resolve(result);
  };
  const retire = () => {
    const previous = session;
    session = null;
    previous?.wake?.();
    for (const entry of pending.values()) settle(entry, retired(entry));
  };
  const owner = async () => {
    if (closed) throw failure("UNAVAILABLE", "Surface channel is closed", 503);
    let value;
    try {
      value = await credentialGate();
    } catch (error) {
      retire();
      throw error;
    }
    if (closed || typeof value !== "string" || !value) {
      retire();
      throw failure("UNAUTHORIZED", "Surface account is unavailable", 403);
    }
    if (session && (session.owner !== value || session.expiresAt <= now()))
      retire();
    return value;
  };
  const current = (scope, actor) => {
    if (
      !scope ||
      session !== scope ||
      scope.owner !== actor ||
      scope.expiresAt <= now()
    )
      throw failure("STALE_REF", "Surface connection is no longer current");
  };
  return {
    /** Opaque session identity, not a provider credential or browser profile claim. */
    connectionId: () => (session?.expiresAt > now() ? session.id : null),
    async handle(path, input) {
      const actor = await owner();
      if (path === "/browser/surface/connect") {
        if (
          !object(input, ["clientId", "epoch"]) ||
          !id(input.clientId) ||
          !Number.isSafeInteger(input.epoch) ||
          input.epoch < 0
        )
          throw failure("INVALID_REQUEST", "Invalid surface connection", 400);
        if (
          session?.clientId === input.clientId &&
          session.epoch === input.epoch
        ) {
          session.expiresAt = now() + 15000;
          return { connectionId: session.id };
        }
        if (input.epoch <= highestEpoch)
          throw failure("STALE_REF", "Surface connection epoch was retired");
        retire();
        highestEpoch = input.epoch;
        session = {
          id: randomUUID(),
          owner: actor,
          clientId: input.clientId,
          epoch: input.epoch,
          sequence: 0,
          expiresAt: now() + 15000,
          cancellations: new Set(),
          wake: null,
        };
        return { connectionId: session.id };
      }
      const scope = session;
      current(scope, actor);
      if (!input || input.connectionId !== scope.id)
        throw failure("STALE_REF", "Wrong surface connection");
      if (path === "/browser/surface/close") {
        if (!object(input, ["connectionId"]))
          throw failure("INVALID_REQUEST", "Invalid close request", 400);
        retire();
        return { closed: true };
      }
      if (path === "/browser/surface/reply") {
        if (
          !object(input, ["connectionId", "id", "result", "error"]) ||
          !id(input.id) ||
          Object.hasOwn(input, "result") === Object.hasOwn(input, "error")
        )
          throw failure("INVALID_REQUEST", "Invalid surface reply", 400);
        const entry = pending.get(input.id);
        if (!entry?.delivered || entry.scope !== scope)
          throw failure("STALE_REF", "Surface command is no longer pending");
        if (entry.expiresAt <= now()) {
          settle(entry, retired(entry));
          throw failure(
            "STALE_REF",
            "Surface reply arrived after its deadline",
          );
        }
        if (input.error !== undefined) {
          if (
            !object(input.error, ["code", "message"]) ||
            typeof input.error.code !== "string" ||
            !/^[A-Z_]{1,64}$/.test(input.error.code) ||
            typeof input.error.message !== "string" ||
            input.error.message.length > 1024
          )
            throw failure("INVALID_REQUEST", "Invalid surface error", 400);
          settle(entry, failure(input.error.code, input.error.message));
        } else settle(entry, null, copy(input.result));
        return { accepted: true };
      }
      if (path !== "/browser/surface/pull" || !object(input, ["connectionId"]))
        throw failure("INVALID_REQUEST", "Unknown surface request", 400);
      if (scope.wake)
        throw failure("BUSY", "Only one surface pull may wait at a time");
      scope.expiresAt = now() + 15000;
      const next = () =>
        [...pending.values()].find(
          (entry) => entry.scope === scope && !entry.delivered,
        );
      if (!next() && !scope.cancellations.size) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            scope.wake = null;
            resolve();
          }, 1000);
          scope.wake = () => {
            clearTimeout(timer);
            scope.wake = null;
            resolve();
          };
        });
      }
      current(scope, await owner());
      const cancellations = [...scope.cancellations];
      scope.cancellations.clear();
      const entry = next();
      if (!entry) return { command: null, cancellations };
      if (entry.expiresAt <= now()) {
        settle(entry, retired(entry));
        return { command: null, cancellations };
      }
      entry.delivered = true;
      return {
        command: {
          id: entry.id,
          sequence: entry.sequence,
          effect: entry.effect,
          expiresAt: entry.expiresAt,
          input: copy(entry.input),
        },
        cancellations,
      };
    },
    async request(input, { signal, effect } = {}) {
      if (typeof effect !== "boolean")
        throw new TypeError(
          "Commands must declare whether they can have an effect",
        );
      const value = copy(input);
      signal?.throwIfAborted();
      const actor = await owner(),
        scope = session;
      current(scope, actor);
      signal?.throwIfAborted();
      if (pending.size >= 16)
        throw failure("BUSY", "Surface command limit reached");
      const result = await new Promise((resolve, reject) => {
        const entry = {
          id: randomUUID(),
          sequence: ++scope.sequence,
          scope,
          input: value,
          expiresAt: now() + timeoutMs,
          signal,
          effect,
          delivered: false,
          resolve,
          reject,
          timer: null,
          abort: null,
        };
        const cancel = () => {
          if (entry.delivered) {
            if (scope.cancellations.size >= 16) {
              retire();
              return;
            }
            scope.cancellations.add(entry.id);
            scope.wake?.();
          }
          settle(entry, retired(entry));
        };
        entry.abort = cancel;
        entry.timer = setTimeout(cancel, timeoutMs);
        pending.set(entry.id, entry);
        signal?.addEventListener("abort", cancel, { once: true });
        scope.wake?.();
      });
      try {
        current(scope, await owner());
        signal?.throwIfAborted();
      } catch {
        throw failure(
          effect ? "UNCERTAIN_OUTCOME" : "STALE_REF",
          "Surface account changed before the reply was accepted",
        );
      }
      return result;
    },
    revoke: retire,
    close() {
      closed = true;
      retire();
    },
  };
}
