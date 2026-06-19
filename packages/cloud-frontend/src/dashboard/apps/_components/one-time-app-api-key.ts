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
