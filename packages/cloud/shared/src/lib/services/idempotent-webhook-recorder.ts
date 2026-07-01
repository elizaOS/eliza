export interface IdempotentWebhookRecorder {
  recordIfNew(provider: string, eventId: string): Promise<boolean>;
}

export function createInMemoryIdempotentWebhookRecorder(): IdempotentWebhookRecorder {
  const seen = new Map<string, Set<string>>();

  return {
    async recordIfNew(provider: string, eventId: string): Promise<boolean> {
      let providerSet = seen.get(provider);
      if (!providerSet) {
        providerSet = new Set<string>();
        seen.set(provider, providerSet);
      }
      if (providerSet.has(eventId)) return false;
      providerSet.add(eventId);
      return true;
    },
  };
}
