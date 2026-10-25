/**
 * Clipboard helper for the API-keys cloud domain. Reflects the real backend
 * contract:
 *
 *   The plaintext of an API key is hashed + KMS-encrypted at rest and is only
 *   returned once, on create / regenerate (see
 *   `packages/cloud/api/v1/api-keys/explorer/route.ts` "D-1"). There is no
 *   endpoint that reveals the secret of an existing key, so "copy the stored
 *   secret" is impossible by design.
 *
 * So this exposes a single operation:
 *   - {@link copyApiKeyToClipboard} — copy a one-time plaintext key (the value
 *     shown in the post-create reveal dialog).
 */

import { copyTextToClipboard } from "../../utils/clipboard";

/**
 * Copy a full plaintext API key (only available in the one-time reveal dialog).
 * Throws if the clipboard is unavailable so the caller can surface an error.
 */
export async function copyApiKeyToClipboard(plainKey: string): Promise<void> {
  await copyTextToClipboard(plainKey);
}
