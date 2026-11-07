/**
 * A random identifier for live voice sessions, recordings and turns: a UUID where the runtime has
 * `crypto.randomUUID`, else a time-and-random fallback. Identifiers only; never a secret.
 */
export function randomId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
