// spec/localInference/models.md, "A download is installed only when every file matches its published digest"
import { createHash } from "node:crypto"

/** A SHA-256 taken over bytes as they arrive. */
export interface RunningDigest {
  /** @throws {never} */
  update(bytes: Uint8Array): void
  /** @throws {never} */
  hex(): string
}

/** Starts a SHA-256 over the bytes it is given. @throws {never} */
export function sha256(): RunningDigest {
  const hash = createHash("sha256")
  return {
    update: (bytes) => { hash.update(bytes) },
    hex: () => hash.digest("hex"),
  }
}
