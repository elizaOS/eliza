/**
 * Resolves the connector send-as account context for a message: which account a
 * reply is sent as, gated by account usability. Consumed by the composer.
 */
import { useCallback, useMemo } from "react";
import type {
  ConnectorAccountActionResult,
  ConnectorAccountRecord,
} from "../api/client-agent";
import {
  buildConnectorSendAsMetadata,
  type ConnectorSendAsContext,
  isConnectorAccountUsable,
  normalizeConnectorSendAsContext,
  shouldShowConnectorAccountPicker,
} from "../components/chat/connector-send-as";
import type { ActionNoticeFn } from "../state/action-notice";
import { isSafeNavigationUrl } from "../utils/navigation-url";
import { useConnectorAccounts } from "./useConnectorAccounts";

const INVALID_AUTH_URL_NOTICE =
  "The sign-in link returned by the server is not a valid URL.";

export interface UseConnectorSendAsAccountOptions {
  pollMs?: number;
  setActionNotice?: ActionNoticeFn;
}

export interface UseConnectorSendAsAccountResult {
  context: ReturnType<typeof normalizeConnectorSendAsContext>;
  accounts: ConnectorAccountRecord[];
  loading: boolean;
  error: string | null;
  saving: Set<string>;
  selectedAccount: ConnectorAccountRecord | null;
  selectedAccountId: string | null;
  sendAsMetadata: Record<string, unknown> | undefined;
  showPicker: boolean;
  accountRequired: boolean;
  accountRequiredReason: string | null;
  selectAccount: (accountId: string | null) => void;
  connectAccount: () => Promise<ConnectorAccountActionResult>;
  reconnectAccount: (
    accountId: string,
  ) => Promise<ConnectorAccountActionResult>;
  refresh: () => Promise<void>;
}

/**
 * Open a connector OAuth URL in a new tab. The authUrl is a wire value, so it
 * passes the navigation scheme allowlist first; returns `false` when nothing
 * was opened (rejected or non-browser environment).
 */
function openAuthUrl(authUrl: string | undefined): boolean {
  if (!authUrl || typeof window === "undefined") return false;
  if (!isSafeNavigationUrl(authUrl)) return false;
  window.open(authUrl, "_blank", "noopener,noreferrer");
  return true;
}

export function useConnectorSendAsAccount(
  rawContext: ConnectorSendAsContext | null | undefined,
  options: UseConnectorSendAsAccountOptions = {},
): UseConnectorSendAsAccountResult {
  const context = useMemo(
    () => normalizeConnectorSendAsContext(rawContext),
    [rawContext],
  );

  const connectorAccounts = useConnectorAccounts(
    context?.provider ?? "",
    context?.connectorId ?? "",
    {
      enabled: Boolean(context),
      pollMs: options.pollMs,
      setActionNotice: options.setActionNotice,
    },
  );

  const {
    accounts,
    data,
    error,
    loading,
    refresh,
    saving,
    selectedAccount,
    setSelectedAccountId,
    startOAuth,
  } = connectorAccounts;
  const selectedAccountId = selectedAccount?.id ?? null;
  const showPicker = shouldShowConnectorAccountPicker(context, accounts);
  const accountRequired =
    Boolean(context?.requiresAccount) &&
    !loading &&
    data !== null &&
    !isConnectorAccountUsable(selectedAccount);
  const accountRequiredReason = accountRequired
    ? selectedAccount
      ? "The selected connector account cannot send right now."
      : "Choose a connector account before sending."
    : null;
  const sendAsMetadata = useMemo(
    () => buildConnectorSendAsMetadata(context, selectedAccount),
    [context, selectedAccount],
  );

  const connectAccount = useCallback(async () => {
    const result = await startOAuth({
      metadata: {
        requestedRole: "OWNER",
        privacy: "owner_only",
      },
    });
    if (result.authUrl && !openAuthUrl(result.authUrl)) {
      options.setActionNotice?.(INVALID_AUTH_URL_NOTICE, "error", 4200);
    }
    return result;
  }, [startOAuth, options.setActionNotice]);

  const reconnectAccount = useCallback(
    async (accountId: string) => {
      const result = await startOAuth({ accountId });
      if (result.authUrl && !openAuthUrl(result.authUrl)) {
        options.setActionNotice?.(INVALID_AUTH_URL_NOTICE, "error", 4200);
      }
      return result;
    },
    [startOAuth, options.setActionNotice],
  );

  return {
    context,
    accounts,
    loading,
    error,
    saving,
    selectedAccount,
    selectedAccountId,
    sendAsMetadata,
    showPicker,
    accountRequired,
    accountRequiredReason,
    selectAccount: setSelectedAccountId,
    connectAccount,
    reconnectAccount,
    refresh,
  };
}
