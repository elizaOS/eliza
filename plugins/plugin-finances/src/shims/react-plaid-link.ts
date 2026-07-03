/**
 * `react-plaid-link` stub for the finances view bundle.
 *
 * The finances plugin owns the Plaid link flow (`createPlaidLinkToken` /
 * `completePlaidLink` in `finances-service.ts`). The renderer does not ship the
 * real `react-plaid-link` widget, so the finances view bundle aliases the
 * package to this stub (see `vite.config.views.ts`) and bundles it inline
 * instead of relying on the shared host shell to provide it.
 */

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
