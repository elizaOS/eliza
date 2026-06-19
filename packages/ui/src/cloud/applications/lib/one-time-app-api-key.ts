/**
 * Cross-component one-time hand-off for a freshly minted app API key.
 *
 * Ported verbatim from
 * `@elizaos/cloud-frontend/src/dashboard/apps/_components/one-time-app-api-key.ts`.
 * When an app is created or its key regenerated, the new key is shown exactly
 * once. We stash it in a module-level map keyed by app id so the detail page's
 * Overview tab can reveal it on first mount, then drop it.
 */

const oneTimeAppApiKeys = new Map<string, string>();

export function storeOneTimeAppApiKey(appId: string, apiKey: string): void {
  if (!appId || !apiKey) return;
  oneTimeAppApiKeys.set(appId, apiKey);
}

export function consumeOneTimeAppApiKey(appId: string): string | undefined {
  const apiKey = oneTimeAppApiKeys.get(appId);
  if (apiKey) {
    oneTimeAppApiKeys.delete(appId);
  }
  return apiKey;
}
