/**
 * Verified sensitive-value writes.
 *
 * Callers that are about to discard a plaintext recovery source must not
 * treat a successful storage call as proof that the protected value is
 * usable. These helpers serialize writes per vault/key, perform an audited
 * exact read-back, and surface a redacted error on any mismatch or read
 * failure.
 */

import type { SetOptions, Vault } from "./vault-types.js";

const writeQueues = new WeakMap<Vault, Map<string, Promise<void>>>();

export class VaultWriteVerificationError extends Error {
  constructor(
    readonly key: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `vault: protected write verification failed for ${JSON.stringify(key)}`,
    );
    this.name = "VaultWriteVerificationError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

async function serializeVaultKeyWrite<T>(
  vault: Vault,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = writeQueues.get(vault);
  if (!queue) {
    queue = new Map();
    writeQueues.set(vault, queue);
  }

  // Queue entries are normalized below and cannot reject; direct chaining
  // preserves per-key ordering.
  const previous = queue.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(
    () => {},
    () => {},
  );
  queue.set(key, settled);

  try {
    return await current;
  } finally {
    if (queue.get(key) === settled) {
      queue.delete(key);
      if (queue.size === 0) writeQueues.delete(vault);
    }
  }
}

function verificationCaller(caller: string | undefined): string {
  return caller ? `${caller}:verify` : "vault:verified-write";
}

async function verifyExactReadBack(
  vault: Vault,
  key: string,
  expected: string,
  caller: string | undefined,
): Promise<void> {
  let actual: string;
  try {
    actual = await vault.reveal(key, verificationCaller(caller));
  } catch (cause) {
    throw new VaultWriteVerificationError(key, { cause });
  }
  if (actual !== expected) throw new VaultWriteVerificationError(key);
}

/** Overwrite a sensitive value, then prove the exact protected read-back. */
export async function writeSensitiveValueVerified(
  vault: Vault,
  key: string,
  value: string,
  opts: Omit<SetOptions, "sensitive"> = {},
): Promise<void> {
  await serializeVaultKeyWrite(vault, key, async () => {
    await vault.set(key, value, { ...opts, sensitive: true });
    await verifyExactReadBack(vault, key, value, opts.caller);
  });
}

/**
 * Atomically establish a sensitive value without replacing an existing row,
 * then prove that the winning protected value exactly matches the caller's
 * recovery source. An unreadable or different existing value is left intact
 * and fails closed.
 */
export async function writeSensitiveValueIfAbsentVerified(
  vault: Vault,
  key: string,
  value: string,
  opts: Omit<SetOptions, "sensitive"> = {},
): Promise<boolean> {
  return serializeVaultKeyWrite(vault, key, async () => {
    const inserted = await vault.setIfAbsent(key, value, {
      ...opts,
      sensitive: true,
    });
    await verifyExactReadBack(vault, key, value, opts.caller);
    return inserted;
  });
}
