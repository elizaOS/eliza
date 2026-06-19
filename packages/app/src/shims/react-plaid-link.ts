export type PlaidLinkOnSuccess = (
  publicToken: string,
  metadata: Record<string, unknown>,
) => void | Promise<void>;

export function usePlaidLink(): { open: () => void; ready: boolean } {
  return {
    open: () => undefined,
    ready: false,
  };
}
