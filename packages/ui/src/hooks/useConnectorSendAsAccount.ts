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
import { useConnectorAccounts } from "./useConnectorAccounts";

type ActionTone = "info" | "success" | "error";

type ActionNoticeFn = (
  text: string,
  tone?: ActionTone,
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

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

function openAuthUrl(authUrl: string | undefined): void {
  if (!authUrl || typeof window === "undefined") return;
  window.open(authUrl, "_blank", "noopener,noreferrer");
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
    openAuthUrl(result.authUrl);
    return result;
  }, [startOAuth]);

  const reconnectAccount = useCallback(
    async (accountId: string) => {
      const result = await startOAuth({ accountId });
      openAuthUrl(result.authUrl);
      return result;
    },
    [startOAuth],
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
