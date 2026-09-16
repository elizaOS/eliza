/** Reads the host-owned canonical token without moving native credentials into plaintext storage. */
import {
  STEWARD_PENDING_WRITE_KEY,
  STEWARD_TOKEN_KEY,
} from "./session-keys.js";

let hostTokenReader: (() => string | null) | null = null;

/** Native hosts expose their verified secure-store mirror, including before proxy initialization. */
export function registerStewardTokenReader(
  reader: () => string | null,
): () => void {
  hostTokenReader = reader;
  return () => {
    if (hostTokenReader === reader) hostTokenReader = null;
  };
}

/** Scope validation belongs to the public session reader; this reads the underlying credential. */
export function readCanonicalStewardToken(): string | null {
  if (typeof window === "undefined") return null;
  if (hostTokenReader) return hostTokenReader();
  if (window.localStorage.getItem(STEWARD_PENDING_WRITE_KEY) !== null)
    return null;
  return window.localStorage.getItem(STEWARD_TOKEN_KEY);
}
