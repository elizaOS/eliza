/**
 * Clipboard helper for the API-keys cloud domain.
 *
 * Replaces the cloud-frontend `@/lib/client/api-keys` module, which never
 * existed on disk — the keys page imported `copyApiKeyToClipboard` /
 * `getClientApiKeySecret` from it, so the "Copy key" action on a stored key
 * threw at module load. The fix reflects the real backend contract:
 *
 *   The plaintext of an API key is hashed + KMS-encrypted at rest and is only
 *   returned once, on create / regenerate (see
 *   `packages/cloud-api/v1/api-keys/explorer/route.ts` "D-1"). There is no
 *   endpoint that reveals the secret of an existing key, so "copy the stored
 *   secret" is impossible by design.
 *
 * So this exposes exactly two operations:
 *   - {@link copyApiKeyToClipboard} — copy a one-time plaintext key (the value
 *     shown in the post-create reveal dialog).
 *   - {@link copyApiKeyPrefix} — copy the public key prefix (the only visible
 *     identifier for a stored key) for the row-level "Copy key" action.
 */

import { copyTextToClipboard } from "../../utils/clipboard";

/**
 * Copy a full plaintext API key (only available in the one-time reveal dialog).
 * Throws if the clipboard is unavailable so the caller can surface an error.
 */
export async function copyApiKeyToClipboard(plainKey: string): Promise<void> {
  await copyTextToClipboard(plainKey);
}

/**
 * Copy the public key prefix for a stored key. The full secret cannot be
 * retrieved after creation, so the prefix is the only copyable identifier.
 */
export async function copyApiKeyPrefix(keyPrefix: string): Promise<void> {
  await copyTextToClipboard(keyPrefix);
}
