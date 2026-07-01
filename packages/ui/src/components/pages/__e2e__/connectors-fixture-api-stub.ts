/**
 * Fixture stand-in for the `src/api` barrel used by run-connectors-e2e.mjs.
 * Serves one canned Signal connector account so the REAL
 * `ConnectorSetupPanel` → `ConnectorAccountManagementPanel` →
 * `ConnectorAccountList` chain renders live account chrome without a server.
 * Unlisted client methods resolve to async no-ops via the Proxy fallback —
 * none are exercised by the render-only walkthrough.
 */

const cannedAccounts = {
  provider: "signal",
  connectorId: "signal",
  defaultAccountId: "acct-signal-owner",
  accounts: [
    {
      id: "acct-signal-owner",
      provider: "signal",
      connectorId: "signal",
      label: "Owner device",
      handle: "+1 555 0100",
      status: "connected",
      role: "OWNER",
      purpose: ["messaging"],
      privacy: "owner_only",
      isDefault: true,
      enabled: true,
    },
  ],
};

const base: Record<string, unknown> = {
  onWsEvent: () => () => {},
  listConnectorAccounts: async (provider: string, connectorId?: string) => ({
    ...cannedAccounts,
    provider,
    connectorId: connectorId ?? provider,
  }),
};

export const client = new Proxy(base, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return async () => undefined;
  },
});
