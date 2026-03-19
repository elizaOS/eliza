import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  SectionCard,
} from "@elizaos/ui";
import {
  AlertCircle,
  CircleDollarSign,
  CreditCard,
  ExternalLink,
  LayoutDashboard,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  Trash2,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type CloudBillingCheckoutResponse,
  type CloudBillingSettings,
  type CloudBillingSummary,
  type CloudCompatAgent,
  client,
} from "../api";
import { useApp } from "../state";
import { openExternalUrl } from "../utils";
import { StripeEmbeddedCheckout } from "./StripeEmbeddedCheckout";

const ELIZA_CLOUD_LOGIN_URL =
  "https://www.elizacloud.ai/login?returnTo=%2Fdashboard%2Feliza";
const ELIZA_CLOUD_INSTANCES_URL = "https://www.elizacloud.ai/dashboard/eliza";
const BILLING_PRESET_AMOUNTS = [10, 25, 100];

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  running: {
    label: "Running",
    className: "bg-ok/10 text-ok border-ok/20",
  },
  queued: {
    label: "Queued",
    className: "bg-warn/10 text-warn border-warn/20",
  },
  provisioning: {
    label: "Provisioning",
    className: "bg-accent/10 text-txt border-accent/20",
  },
  stopped: {
    label: "Stopped",
    className: "bg-muted/10 text-muted border-border/40",
  },
  failed: {
    label: "Failed",
    className: "bg-danger/10 text-danger border-danger/20",
  },
};

function AgentStatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.stopped;
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${badge?.className}`}
    >
      {badge?.label}
    </span>
  );
}

function CloudAgentCard({
  agent,
  onDelete,
  deleting,
  launching,
  onLaunch,
  onSelect,
}: {
  agent: CloudCompatAgent;
  onDelete: (id: string) => void;
  deleting: boolean;
  launching: boolean;
  onLaunch: (id: string) => void;
  onSelect?: (id: string) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: cannot use button due to nested buttons
    <div
      className="rounded-2xl border border-border/50 bg-bg/30 p-5 flex flex-col justify-between gap-4 hover:border-accent/30 transition-all duration-200 cursor-pointer"
      onClick={() => onSelect?.(agent.agent_id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(agent.agent_id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-txt shrink-0" />
          <span className="font-bold text-sm text-txt-strong truncate max-w-[140px]">
            {agent.agent_name || "Unnamed Agent"}
          </span>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <div className="text-[11px] text-muted space-y-1">
        <div className="flex justify-between">
          <span>Node</span>
          <span className="font-mono text-txt-strong/70">
            {agent.node_id?.slice(0, 8) ?? "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Created</span>
          <span className="text-txt-strong/70">
            {new Date(agent.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <div className="flex gap-2 mt-1">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 rounded-xl h-8 text-xs border-border/40"
          onClick={(event) => {
            event.stopPropagation();
            onLaunch(agent.agent_id);
          }}
          disabled={launching}
        >
          {launching ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <ExternalLink className="w-3 h-3 mr-1" />
          )}
          Open
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="settings-icon-button rounded-xl h-8 text-xs border-danger/30 text-danger hover:bg-danger/10"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(agent.agent_id);
          }}
          disabled={deleting || launching}
        >
          {deleting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapBillingData<T extends Record<string, unknown>>(value: T): T {
  if (isRecord(value.data)) {
    return value.data as T;
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeBillingSummary(
  raw: CloudBillingSummary,
): CloudBillingSummary {
  const source = unwrapBillingData(raw);
  return {
    ...raw,
    ...source,
    balance:
      readNumber(source.balance) ??
      readNumber((source as Record<string, unknown>).creditBalance) ??
      null,
    currency:
      readString(source.currency) ??
      readString((source as Record<string, unknown>).balanceCurrency),
    topUpUrl:
      readString(source.topUpUrl) ??
      readString((source as Record<string, unknown>).billingUrl),
    embeddedCheckoutEnabled:
      readBoolean(source.embeddedCheckoutEnabled) ??
      readBoolean((source as Record<string, unknown>).embedded),
    hostedCheckoutEnabled:
      readBoolean(source.hostedCheckoutEnabled) ??
      readBoolean((source as Record<string, unknown>).hosted),
    cryptoEnabled:
      readBoolean(source.cryptoEnabled) ??
      readBoolean((source as Record<string, unknown>).crypto),
    low: readBoolean(source.low),
    critical: readBoolean(source.critical),
  };
}

function normalizeBillingSettings(
  raw: CloudBillingSettings,
): CloudBillingSettings {
  const source = unwrapBillingData(raw);
  return {
    ...raw,
    ...source,
    settings: isRecord(source.settings) ? source.settings : raw.settings,
  };
}

function getBillingAutoTopUp(
  settings: CloudBillingSettings | null,
): Record<string, unknown> {
  const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
  return isRecord(rawSettings?.autoTopUp) ? rawSettings.autoTopUp : {};
}

function getBillingLimits(
  settings: CloudBillingSettings | null,
): Record<string, unknown> {
  const rawSettings = isRecord(settings?.settings) ? settings.settings : null;
  return isRecord(rawSettings?.limits) ? rawSettings.limits : {};
}

function resolveCheckoutUrl(
  response: CloudBillingCheckoutResponse,
): string | null {
  return (
    readString(response.checkoutUrl) ??
    readString(response.url) ??
    readString((response as Record<string, unknown>).hostedUrl) ??
    null
  );
}

interface AutoTopUpFormState {
  amount: string;
  dirty: boolean;
  enabled: boolean;
  sourceKey: string;
  threshold: string;
}

type AutoTopUpFormAction =
  | { type: "hydrate"; next: AutoTopUpFormState; force?: boolean }
  | { type: "setAmount"; value: string }
  | { type: "setEnabled"; value: boolean }
  | { type: "setThreshold"; value: string };

function buildAutoTopUpFormState(
  billingSummary: CloudBillingSummary | null,
  billingSettings: CloudBillingSettings | null,
): AutoTopUpFormState {
  const autoTopUp = getBillingAutoTopUp(billingSettings);
  const minimumTopUp =
    readNumber(
      (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
    ) ?? 1;
  const enabled = readBoolean(autoTopUp.enabled) ?? false;
  const amount = String(readNumber(autoTopUp.amount) ?? minimumTopUp);
  const threshold = String(readNumber(autoTopUp.threshold) ?? 5);
  return {
    amount,
    dirty: false,
    enabled,
    sourceKey: JSON.stringify([enabled, amount, threshold]),
    threshold,
  };
}

function autoTopUpFormReducer(
  state: AutoTopUpFormState,
  action: AutoTopUpFormAction,
): AutoTopUpFormState {
  switch (action.type) {
    case "hydrate":
      if (!action.force && state.dirty) {
        return state;
      }
      if (state.sourceKey === action.next.sourceKey && !state.dirty) {
        return state;
      }
      return action.next;
    case "setAmount":
      return { ...state, amount: action.value, dirty: true };
    case "setEnabled":
      return { ...state, enabled: action.value, dirty: true };
    case "setThreshold":
      return { ...state, threshold: action.value, dirty: true };
    default:
      return state;
  }
}

export function CloudDashboard() {
  const {
    t,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    elizaCloudTopUpUrl,
    elizaCloudUserId,
    cloudDashboardView,
    elizaCloudLoginBusy,
    handleCloudLogin,
    handleCloudDisconnect,
    elizaCloudDisconnecting: cloudDisconnecting,
    loadDropStatus,
    walletAddresses,
    walletBalances,
    retryStartup,
    setActionNotice,
    setState,
    setTab,
  } = useApp();

  const [refreshing, setRefreshing] = useState(false);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] =
    useState<CloudBillingSummary | null>(null);
  const [billingSettings, setBillingSettings] =
    useState<CloudBillingSettings | null>(null);
  const [billingAmount, setBillingAmount] = useState("25");
  const [autoTopUpForm, dispatchAutoTopUpForm] = useReducer(
    autoTopUpFormReducer,
    buildAutoTopUpFormState(null, null),
  );
  const [billingSettingsBusy, setBillingSettingsBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CloudBillingCheckoutResponse | null>(null);
  const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false);
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoQuote, setCryptoQuote] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [cryptoPayBusy, setCryptoPayBusy] = useState(false);
  const [cryptoPayResult, setCryptoPayResult] = useState<string | null>(null);
  const [cloudAgents, setCloudAgents] = useState<CloudCompatAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = cloudAgents.find((a) => a.agent_id === selectedAgentId);
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [deployAgentName, setDeployAgentName] = useState("");
  const [deploying, setDeploying] = useState(false);
  const mountedRef = useRef(true);
  const autoTopUpEnabled = autoTopUpForm.enabled;
  const autoTopUpAmount = autoTopUpForm.amount;
  const autoTopUpThreshold = autoTopUpForm.threshold;

  const fetchCloudAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await client.getCloudCompatAgents();
      if (!mountedRef.current) return;
      setCloudAgents(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      if (!mountedRef.current) return;
      setAgentsError(
        err instanceof Error ? err.message : "Failed to load cloud agents",
      );
      setCloudAgents([]);
    } finally {
      if (mountedRef.current) setAgentsLoading(false);
    }
  }, []);

  const fetchBillingData = useCallback(async () => {
    setBillingLoading(true);
    setBillingError(null);
    try {
      const [summaryResponse, settingsResponse] = await Promise.all([
        client.getCloudBillingSummary().catch((err) => ({ __error: err })),
        client.getCloudBillingSettings().catch((err) => ({
          __error: err,
        })),
      ]);

      if (!mountedRef.current) return;

      if (isRecord(summaryResponse) && "__error" in summaryResponse) {
        const err = summaryResponse.__error;
        throw err instanceof Error
          ? err
          : new Error("Billing summary unavailable.");
      }

      setBillingSummary(normalizeBillingSummary(summaryResponse));

      if (isRecord(settingsResponse) && !("__error" in settingsResponse)) {
        setBillingSettings(normalizeBillingSettings(settingsResponse));
      } else {
        setBillingSettings(null);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setBillingSummary(null);
      setBillingSettings(null);
      setBillingError(
        err instanceof Error ? err.message : "Failed to load billing data.",
      );
    } finally {
      if (mountedRef.current) {
        setBillingLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    dispatchAutoTopUpForm({
      type: "hydrate",
      next: buildAutoTopUpFormState(billingSummary, billingSettings),
    });
  }, [billingSettings, billingSummary]);

  const handleDeleteAgent = useCallback(
    async (agentId: string) => {
      setDeletingAgentId(agentId);
      try {
        const data = await client.deleteCloudCompatAgent(agentId);
        if (data.success) {
          setCloudAgents((prev) => prev.filter((a) => a.agent_id !== agentId));
        }
      } catch {
        // Silently fail — user can retry
      } finally {
        setDeletingAgentId(null);
        if (selectedAgentId === agentId) setSelectedAgentId(null);
      }
    },
    [selectedAgentId],
  );

  const handleDeployAgent = useCallback(async () => {
    if (!deployAgentName.trim()) return;
    setDeploying(true);
    try {
      const response = await client.createCloudCompatAgent({
        agentName: deployAgentName.trim(),
      });
      if (response.success) {
        await fetchCloudAgents();
        setShowDeployForm(false);
        setDeployAgentName("");
      }
    } catch {
      // Intentionally swallow for now
    } finally {
      setDeploying(false);
    }
  }, [deployAgentName, fetchCloudAgents]);

  const handleLaunchAgent = useCallback(
    async (agentId: string) => {
      setLaunchingAgentId(agentId);
      try {
        const response = await client.launchCloudCompatAgent(agentId);
        if (!response.success || !response.data?.connection?.apiBase) {
          throw new Error("Eliza Cloud did not return a launch connection.");
        }

        const { connection } = response.data;
        client.setBaseUrl(connection.apiBase);
        client.setToken(connection.token);
        setState("startupError", null);
        setState("onboardingRunMode", "cloud");
        setState("onboardingCloudProvider", "elizacloud");
        setState("onboardingRemoteApiBase", connection.apiBase);
        setState("onboardingRemoteToken", connection.token);
        setState("onboardingRemoteError", null);
        setState("onboardingRemoteConnecting", false);
        setState("onboardingRemoteConnected", false);
        setActionNotice(
          "Opened managed Eliza Cloud instance.",
          "success",
          3000,
        );
        setTab("chat");
        retryStartup();
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : "Failed to open Eliza Cloud instance.",
          "error",
          4200,
        );
      } finally {
        if (mountedRef.current) {
          setLaunchingAgentId(null);
        }
      }
    },
    [retryStartup, setActionNotice, setState, setTab],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      loadDropStatus(),
      fetchCloudAgents(),
      fetchBillingData(),
    ]);
    setTimeout(() => setRefreshing(false), 600);
  }, [fetchBillingData, fetchCloudAgents, loadDropStatus]);

  const handleSaveBillingSettings = useCallback(async () => {
    const limits = getBillingLimits(billingSettings);
    const amount = Number(autoTopUpAmount);
    const threshold = Number(autoTopUpThreshold);
    const minAmount = readNumber(limits.minAmount) ?? 1;
    const maxAmount = readNumber(limits.maxAmount) ?? 1000;
    const minThreshold = readNumber(limits.minThreshold) ?? 0;
    const maxThreshold = readNumber(limits.maxThreshold) ?? 1000;
    const hasPaymentMethod =
      readBoolean(getBillingAutoTopUp(billingSettings).hasPaymentMethod) ??
      readBoolean(
        (billingSummary as Record<string, unknown> | null)?.hasPaymentMethod,
      ) ??
      false;

    if (!Number.isFinite(amount) || amount < minAmount || amount > maxAmount) {
      setActionNotice(
        `Auto top-up amount must be between $${minAmount} and $${maxAmount}.`,
        "error",
        3600,
      );
      return;
    }

    if (
      !Number.isFinite(threshold) ||
      threshold < minThreshold ||
      threshold > maxThreshold
    ) {
      setActionNotice(
        `Auto top-up threshold must be between $${minThreshold} and $${maxThreshold}.`,
        "error",
        3600,
      );
      return;
    }

    if (autoTopUpEnabled && !hasPaymentMethod) {
      setActionNotice(
        "Save a payment method through card checkout before enabling auto top-up.",
        "info",
        4200,
      );
      return;
    }

    setBillingSettingsBusy(true);
    try {
      const response = await client.updateCloudBillingSettings({
        autoTopUp: {
          enabled: autoTopUpEnabled,
          amount,
          threshold,
        },
      });
      if (!mountedRef.current) return;
      const normalizedSettings = normalizeBillingSettings(response);
      setBillingSettings(normalizedSettings);
      dispatchAutoTopUpForm({
        type: "hydrate",
        next: buildAutoTopUpFormState(billingSummary, normalizedSettings),
        force: true,
      });
      await fetchBillingData();
      setActionNotice("Billing settings updated.", "success", 3200);
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : "Failed to update billing settings.",
        "error",
        4200,
      );
    } finally {
      if (mountedRef.current) {
        setBillingSettingsBusy(false);
      }
    }
  }, [
    autoTopUpAmount,
    autoTopUpEnabled,
    autoTopUpThreshold,
    billingSettings,
    billingSummary,
    fetchBillingData,
    setActionNotice,
  ]);

  const handleStartCheckout = useCallback(async () => {
    const minimumTopUp =
      readNumber(
        (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
      ) ?? 1;
    const amountUsd = Number(billingAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
      setActionNotice(
        `Enter a top-up amount of at least $${minimumTopUp}.`,
        "error",
        3200,
      );
      return;
    }

    setCheckoutBusy(true);
    try {
      const response = await client.createCloudBillingCheckout({
        amountUsd,
        mode: billingSummary?.embeddedCheckoutEnabled ? "embedded" : "hosted",
      });

      const clientSecret = readString(response.clientSecret);
      const publishableKey = readString(response.publishableKey);
      if (clientSecret && publishableKey) {
        setCheckoutSession(response);
        setCheckoutDialogOpen(true);
        return;
      }

      const checkoutUrl = resolveCheckoutUrl(response);
      if (checkoutUrl) {
        await openExternalUrl(checkoutUrl);
        return;
      }

      throw new Error(
        readString(response.message) ??
          "Eliza Cloud did not return a checkout session.",
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to start checkout.",
        "error",
        4200,
      );
    } finally {
      setCheckoutBusy(false);
    }
  }, [billingAmount, billingSummary, setActionNotice]);

  const handleCreateCryptoQuote = useCallback(async () => {
    const minimumTopUp =
      readNumber(
        (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
      ) ?? 1;
    const amountUsd = Number(billingAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
      setActionNotice(
        `Enter a top-up amount of at least $${minimumTopUp}.`,
        "error",
        3200,
      );
      return;
    }

    setCryptoBusy(true);
    setCryptoPayResult(null);
    try {
      const response = await client.createCloudBillingCryptoQuote({
        amountUsd,
        walletAddress:
          walletAddresses?.evmAddress ??
          walletAddresses?.solanaAddress ??
          undefined,
      });
      setCryptoQuote(response as Record<string, unknown>);
    } catch (err) {
      setCryptoQuote(null);
      setActionNotice(
        err instanceof Error ? err.message : "Failed to request crypto quote.",
        "error",
        4200,
      );
    } finally {
      setCryptoBusy(false);
    }
  }, [billingAmount, billingSummary, setActionNotice, walletAddresses]);

  const handlePayCryptoFromAgentWallet = useCallback(async () => {
    if (!cryptoQuote) return;

    const network = readString(cryptoQuote.network)?.toLowerCase();
    const payToAddress =
      readString(cryptoQuote.payToAddress) ??
      readString((cryptoQuote as Record<string, unknown>).address);
    const amount = readString(cryptoQuote.amount);
    const currency = readString(cryptoQuote.currency) ?? "USDC";
    const tokenAddress = readString(cryptoQuote.tokenAddress);

    if (!network || network !== "bsc") {
      setActionNotice(
        "Agent-wallet payment is currently wired for BSC quotes only.",
        "info",
        4200,
      );
      return;
    }

    if (!payToAddress || !amount) {
      setActionNotice(
        "Crypto quote is missing transfer details.",
        "error",
        4200,
      );
      return;
    }

    setCryptoPayBusy(true);
    try {
      const result = await client.executeBscTransfer({
        toAddress: payToAddress,
        amount,
        assetSymbol: currency,
        tokenAddress: tokenAddress ?? undefined,
        confirm: true,
      });

      if (result.executed && result.execution?.hash) {
        setCryptoPayResult(
          `Submitted ${currency} payment: ${result.execution.hash}`,
        );
        setActionNotice(
          "Crypto payment submitted from the agent wallet.",
          "success",
        );
      } else if (result.requiresUserSignature) {
        setCryptoPayResult(
          "Cloud returned an unsigned payment request. Sign it from the wallet flow to complete payment.",
        );
        setActionNotice(
          "This wallet requires user-sign mode for crypto payment.",
          "info",
          4200,
        );
      }
    } catch (err) {
      setCryptoPayResult(null);
      setActionNotice(
        err instanceof Error ? err.message : "Crypto payment failed.",
        "error",
        4200,
      );
    } finally {
      setCryptoPayBusy(false);
    }
  }, [cryptoQuote, setActionNotice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (elizaCloudConnected) {
      void loadDropStatus();
      void fetchCloudAgents();
      void fetchBillingData();
    }
  }, [fetchBillingData, fetchCloudAgents, loadDropStatus, elizaCloudConnected]);

  const summaryCritical =
    billingSummary?.critical ?? elizaCloudCreditsCritical ?? false;
  const summaryLow = billingSummary?.low ?? elizaCloudCreditsLow ?? false;
  const creditStatusColor = summaryCritical
    ? "text-danger"
    : summaryLow
      ? "text-warn"
      : "text-ok";
  const activeView = cloudDashboardView;
  const cloudBalance = billingSummary?.balance ?? elizaCloudCredits ?? 0;
  const cloudCurrency = billingSummary?.currency ?? "USD";
  const fallbackBillingUrl =
    billingSummary?.topUpUrl ?? elizaCloudTopUpUrl ?? null;
  const minimumTopUp =
    readNumber(
      (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
    ) ?? 1;
  const billingAutoTopUp = getBillingAutoTopUp(billingSettings);
  const billingLimits = getBillingLimits(billingSettings);
  const autoTopUpHasPaymentMethod =
    readBoolean(billingAutoTopUp.hasPaymentMethod) ??
    readBoolean(
      (billingSummary as Record<string, unknown> | null)?.hasPaymentMethod,
    ) ??
    false;
  const autoTopUpMinAmount =
    readNumber(billingLimits.minAmount) ?? minimumTopUp;
  const autoTopUpMaxAmount = readNumber(billingLimits.maxAmount) ?? 1000;
  const autoTopUpMinThreshold = readNumber(billingLimits.minThreshold) ?? 0;
  const autoTopUpMaxThreshold = readNumber(billingLimits.maxThreshold) ?? 1000;
  const creditStatusTone = summaryCritical
    ? t("elizaclouddashboard.CreditsCritical")
    : summaryLow
      ? t("elizaclouddashboard.CreditsLow")
      : t("elizaclouddashboard.CreditsHealthy");
  const hasAgentWallet = Boolean(
    walletAddresses?.evmAddress || walletAddresses?.solanaAddress,
  );
  const hasWalletFunds = Boolean(
    walletBalances?.evm?.chains.some(
      (chain) =>
        Number(chain.nativeBalance) > 0 ||
        chain.tokens.some((token) => Number(token.balance) > 0),
    ) ||
      ((walletBalances?.solana &&
        (Number(walletBalances.solana.solBalance) > 0 ||
          walletBalances.solana.tokens.some(
            (token) => Number(token.balance) > 0,
          ))) ??
        false),
  );

  if (!elizaCloudConnected) {
    return (
      <div className="flex flex-col items-center justify-center max-w-md mx-auto px-4 py-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mb-5 border border-accent/20">
          <Zap className="w-6 h-6 text-txt" />
        </div>
        <p className="text-sm text-muted mb-6 leading-relaxed">
          {t("elizaclouddashboard.ScaleYourAgents")}
        </p>
        <Button
          variant="default"
          size="sm"
          className="rounded-xl px-8 py-3 text-sm font-semibold shadow-md shadow-accent/15 hover:shadow-accent/30 hover:-translate-y-0.5 transition-all duration-300"
          onClick={handleCloudLogin}
          disabled={elizaCloudLoginBusy}
        >
          {elizaCloudLoginBusy ? (
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Zap className="w-4 h-4 mr-2" />
          )}
          {elizaCloudLoginBusy
            ? t("elizaclouddashboard.Connecting")
            : t("elizaclouddashboard.ConnectElizaCloud")}
        </Button>
        <p className="mt-4 text-xs text-muted/60">
          {t("elizaclouddashboard.NewToElizaCloud")}{" "}
          <a
            href={ELIZA_CLOUD_LOGIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-txt underline hover:text-txt-hover transition-colors"
          >
            {t("elizaclouddashboard.LearnMore")}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="custom-scrollbar p-6 lg:p-10 space-y-10 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-4 mb-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent p-2.5 shadow-lg shadow-accent/20">
              <LayoutDashboard className="h-5 w-5 shrink-0 text-accent-fg" />
            </div>
            <h1 className="text-3xl font-bold text-txt-strong tracking-tight">
              {t("elizaclouddashboard.CloudDashboard")}
            </h1>
          </div>
          <p className="text-muted mt-1">
            {t("elizaclouddashboard.ManageInstance")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-1 rounded-2xl border border-border/50 bg-bg/50 p-1">
            <button
              type="button"
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                activeView === "billing"
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-txt"
              }`}
              onClick={() => setState("cloudDashboardView", "billing")}
            >
              <CircleDollarSign className="w-4 h-4" />
              {t("elizaclouddashboard.CloudBilling")}
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                activeView === "agents"
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-txt"
              }`}
              onClick={() => setState("cloudDashboardView", "agents")}
            >
              <Server className="w-4 h-4" />
              {t("elizaclouddashboard.CloudAgents")}
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl border-border/50 bg-bg/50 backdrop-blur-sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("elizaclouddashboard.Refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl border-danger/30 text-danger hover:bg-danger/10"
            onClick={handleCloudDisconnect}
            disabled={cloudDisconnecting}
          >
            {cloudDisconnecting
              ? t("elizaclouddashboard.Disconnecting")
              : t("elizaclouddashboard.Disconnect")}
          </Button>
        </div>
      </div>

      {activeView === "billing" ? (
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-8">
          <div className="space-y-8">
            <SectionCard
              title={t("elizaclouddashboard.CloudBilling")}
              description={t("elizaclouddashboard.CloudBillingDesc")}
              className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl shadow-sm"
            >
              {billingError && (
                <div className="mt-4 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                  {billingError}
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-[28px] border border-accent/20 bg-[linear-gradient(160deg,rgba(var(--accent),0.16),rgba(255,255,255,0.02))] p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
                        {t("elizaclouddashboard.AvailableBalance")}
                      </div>
                      <div
                        className={`mt-3 text-4xl font-bold tracking-tight sm:text-5xl ${creditStatusColor}`}
                      >
                        {cloudCurrency === "USD" ? "$" : `${cloudCurrency} `}
                        {cloudBalance.toFixed(2)}
                      </div>
                      <div className="mt-3 text-sm text-muted">
                        {t("elizaclouddashboard.InAppBillingReady")}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {billingLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted" />
                      ) : null}
                      <span
                        className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                          summaryCritical
                            ? "border-danger/30 bg-danger/10 text-danger"
                            : summaryLow
                              ? "border-warn/30 bg-warn/10 text-warn"
                              : "border-ok/30 bg-ok/10 text-ok"
                        }`}
                      >
                        {creditStatusTone}
                      </span>
                    </div>
                  </div>

                  <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-border/40 bg-bg/30 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
                        {t("elizaclouddashboard.TopUpCredits")}
                      </div>
                      <div className="mt-2 text-sm text-txt-strong">
                        {t("elizaclouddashboard.MinimumTopUp", {
                          amount: minimumTopUp.toFixed(2),
                        })}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-border/40 bg-bg/30 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
                        {t("elizaclouddashboard.AutoTopUp")}
                      </div>
                      <div className="mt-2 text-sm text-txt-strong">
                        {autoTopUpEnabled
                          ? t("elizaclouddashboard.Enabled")
                          : t("elizaclouddashboard.Disabled")}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-border/50 bg-bg/25 p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-txt-strong">
                        {t("elizaclouddashboard.AutoTopUp")}
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        {t("elizaclouddashboard.AutoTopUpDesc")}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        dispatchAutoTopUpForm({
                          type: "setEnabled",
                          value: !autoTopUpEnabled,
                        })
                      }
                      className={`relative inline-flex h-7 w-12 items-center rounded-full border transition-colors ${
                        autoTopUpEnabled
                          ? "border-accent bg-accent"
                          : "border-border/60 bg-bg/50"
                      }`}
                      aria-label={t("elizaclouddashboard.ToggleAutoTopUp")}
                    >
                      <span
                        className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${
                          autoTopUpEnabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-4 rounded-2xl border border-border/40 bg-bg/20 px-4 py-3 text-sm text-muted">
                    {autoTopUpHasPaymentMethod
                      ? t("elizaclouddashboard.AutoTopUpPaymentReady")
                      : t("elizaclouddashboard.AutoTopUpNeedsPaymentMethod")}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label
                        htmlFor="cloud-auto-topup-threshold"
                        className="text-xs font-medium text-muted"
                      >
                        {t("elizaclouddashboard.AutoTopUpThreshold")}
                      </label>
                      <Input
                        id="cloud-auto-topup-threshold"
                        type="number"
                        min={String(autoTopUpMinThreshold)}
                        max={String(autoTopUpMaxThreshold)}
                        step="1"
                        value={autoTopUpThreshold}
                        onChange={(event) =>
                          dispatchAutoTopUpForm({
                            type: "setThreshold",
                            value: event.target.value,
                          })
                        }
                        className="rounded-xl bg-bg"
                      />
                    </div>
                    <div className="space-y-2">
                      <label
                        htmlFor="cloud-auto-topup-amount"
                        className="text-xs font-medium text-muted"
                      >
                        {t("elizaclouddashboard.AutoTopUpAmount")}
                      </label>
                      <Input
                        id="cloud-auto-topup-amount"
                        type="number"
                        min={String(autoTopUpMinAmount)}
                        max={String(autoTopUpMaxAmount)}
                        step="1"
                        value={autoTopUpAmount}
                        onChange={(event) =>
                          dispatchAutoTopUpForm({
                            type: "setAmount",
                            value: event.target.value,
                          })
                        }
                        className="rounded-xl bg-bg"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs text-muted">
                      {t("elizaclouddashboard.AutoTopUpLimits", {
                        minAmount: autoTopUpMinAmount,
                        maxAmount: autoTopUpMaxAmount,
                        minThreshold: autoTopUpMinThreshold,
                        maxThreshold: autoTopUpMaxThreshold,
                      })}
                    </div>
                    <Button
                      variant="outline"
                      className="rounded-2xl border-border/50"
                      disabled={
                        billingSettingsBusy ||
                        billingLoading ||
                        !autoTopUpForm.dirty
                      }
                      onClick={() => void handleSaveBillingSettings()}
                    >
                      {billingSettingsBusy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      {t("elizaclouddashboard.SaveBillingSettings")}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="mt-6 rounded-[28px] border border-border/50 bg-bg/25 p-5 sm:p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-txt-strong">
                      {t("elizaclouddashboard.TopUpCredits")}
                    </div>
                    <div className="mt-1 text-sm text-muted">
                      {t("elizaclouddashboard.TopUpCreditsDesc")}
                    </div>
                  </div>

                  {fallbackBillingUrl ? (
                    <Button
                      variant="ghost"
                      className="justify-start rounded-2xl px-0 text-sm text-muted hover:text-txt"
                      onClick={() => void openExternalUrl(fallbackBillingUrl)}
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {t("elizaclouddashboard.OpenBrowserBilling")}
                    </Button>
                  ) : null}
                </div>

                <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {BILLING_PRESET_AMOUNTS.map((amount) => (
                        <button
                          key={amount}
                          type="button"
                          className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                            billingAmount === String(amount)
                              ? "border-accent bg-accent text-accent-fg"
                              : "border-border/50 bg-bg/30 text-txt hover:border-accent/40"
                          }`}
                          onClick={() => setBillingAmount(String(amount))}
                        >
                          ${amount}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label
                          htmlFor="cloud-billing-amount"
                          className="text-xs font-medium text-muted"
                        >
                          {t("elizaclouddashboard.CustomAmount")}
                        </label>
                        <Input
                          id="cloud-billing-amount"
                          type="number"
                          min={String(minimumTopUp)}
                          step="1"
                          value={billingAmount}
                          onChange={(event) =>
                            setBillingAmount(event.target.value)
                          }
                          className="rounded-xl bg-bg"
                        />
                      </div>
                      <div className="rounded-2xl border border-border/40 bg-bg/20 px-4 py-3 text-sm text-muted">
                        {t("elizaclouddashboard.MinimumTopUp", {
                          amount: minimumTopUp.toFixed(2),
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <Button
                      variant="default"
                      className="h-12 rounded-2xl font-semibold"
                      disabled={checkoutBusy || billingLoading}
                      onClick={() => void handleStartCheckout()}
                    >
                      {checkoutBusy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <CreditCard className="mr-2 h-4 w-4" />
                      )}
                      {t("elizaclouddashboard.PayWithCard")}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-12 rounded-2xl border-border/50"
                      disabled={cryptoBusy || billingLoading}
                      onClick={() => void handleCreateCryptoQuote()}
                    >
                      {cryptoBusy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Wallet className="mr-2 h-4 w-4" />
                      )}
                      {t("elizaclouddashboard.PayWithCrypto")}
                    </Button>
                    <div className="rounded-2xl border border-border/40 bg-bg/20 px-4 py-3 text-xs text-muted">
                      {t("elizaclouddashboard.CheckoutProviderNote")}
                    </div>
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>

          <div className="space-y-8">
            <SectionCard
              title={t("elizaclouddashboard.CryptoTopUp")}
              description={t("elizaclouddashboard.CryptoTopUpDesc")}
              className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl shadow-sm"
            >
              <div className="mt-2 space-y-4">
                <div className="rounded-2xl border border-border/40 bg-bg/25 px-4 py-3 text-sm text-muted">
                  {hasAgentWallet
                    ? hasWalletFunds
                      ? t("elizaclouddashboard.AgentWalletFunded")
                      : t("elizaclouddashboard.AgentWalletDetected")
                    : t("elizaclouddashboard.NoAgentWalletDetected")}
                </div>

                {cryptoQuote ? (
                  <div className="rounded-2xl border border-border/40 bg-bg/25 p-4">
                    <div className="space-y-2 text-sm">
                      <div className="font-semibold text-txt-strong">
                        {readString(cryptoQuote.provider) ??
                          t("elizaclouddashboard.CryptoQuoteReady")}
                      </div>
                      <div className="text-muted">
                        {readString(cryptoQuote.currency) ?? "USDC"}{" "}
                        {readString(cryptoQuote.amount) ?? "0"} on{" "}
                        {readString(cryptoQuote.network) ?? "selected network"}
                      </div>
                      {readString(cryptoQuote.payToAddress) && (
                        <code className="block rounded-xl border border-border/40 bg-bg/30 px-3 py-2 text-xs text-txt-strong break-all">
                          {readString(cryptoQuote.payToAddress)}
                        </code>
                      )}
                      {readString(cryptoQuote.expiresAt) && (
                        <div className="text-xs text-muted">
                          Expires{" "}
                          {new Date(
                            readString(cryptoQuote.expiresAt) ?? "",
                          ).toLocaleString()}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex flex-col gap-3">
                      {readString(cryptoQuote.paymentLinkUrl) ? (
                        <Button
                          variant="outline"
                          className="rounded-2xl"
                          onClick={() =>
                            void openExternalUrl(
                              readString(cryptoQuote.paymentLinkUrl) ?? "",
                            )
                          }
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {t("elizaclouddashboard.OpenHostedCryptoCheckout")}
                        </Button>
                      ) : null}

                      <Button
                        variant="default"
                        className="rounded-2xl"
                        disabled={
                          cryptoPayBusy ||
                          !hasAgentWallet ||
                          !hasWalletFunds ||
                          readString(cryptoQuote.network)?.toLowerCase() !==
                            "bsc" ||
                          !readString(cryptoQuote.payToAddress) ||
                          !readString(cryptoQuote.amount)
                        }
                        onClick={() => void handlePayCryptoFromAgentWallet()}
                      >
                        {cryptoPayBusy ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Wallet className="mr-2 h-4 w-4" />
                        )}
                        {t("elizaclouddashboard.PayFromAgentWallet")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border/50 bg-bg/20 px-4 py-5 text-sm text-muted">
                    {t("elizaclouddashboard.CryptoQuoteHint")}
                  </div>
                )}

                {cryptoPayResult && (
                  <div className="rounded-2xl border border-ok/30 bg-ok/10 px-4 py-3 text-sm text-ok">
                    {cryptoPayResult}
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard
              title={t("elizaclouddashboard.AccountDetails")}
              className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl shadow-sm"
            >
              <div className="space-y-5 mt-4">
                <div className="p-4 rounded-2xl bg-bg/30 border border-border/30">
                  <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-2 block">
                    {t("elizaclouddashboard.CloudUserID")}
                  </span>
                  <code className="text-xs text-txt-strong break-all font-mono">
                    {elizaCloudUserId || t("elizaclouddashboard.NotAvailable")}
                  </code>
                </div>

                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-ok" />
                    <span className="text-xs font-medium">
                      {t("elizaclouddashboard.SecurityStatus")}
                    </span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-ok/10 text-ok font-bold uppercase tracking-wider border border-ok/20">
                    {t("elizaclouddashboard.Secure")}
                  </span>
                </div>

                <Button
                  variant="link"
                  className="settings-compact-button w-full text-xs text-txt justify-start px-3 h-auto"
                  onClick={() =>
                    void openExternalUrl(ELIZA_CLOUD_INSTANCES_URL)
                  }
                >
                  {t("elizaclouddashboard.AdvancedDashboard")}
                  <ExternalLink className="w-3 h-3 ml-2" />
                </Button>
              </div>
            </SectionCard>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <SectionCard
              title={t("elizaclouddashboard.CloudAgents")}
              description={t("elizaclouddashboard.CloudAgentsDesc")}
              className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl overflow-hidden shadow-sm"
            >
              {agentsError && (
                <div className="mt-6 flex items-center gap-3 text-sm text-danger bg-danger/10 rounded-xl p-4 border border-danger/20">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {agentsError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-6">
                {agentsLoading && cloudAgents.length === 0 ? (
                  <div className="col-span-full flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 text-txt animate-spin" />
                  </div>
                ) : (
                  <>
                    {cloudAgents.map((agent) => (
                      <CloudAgentCard
                        key={agent.agent_id}
                        agent={agent}
                        onDelete={handleDeleteAgent}
                        deleting={deletingAgentId === agent.agent_id}
                        launching={launchingAgentId === agent.agent_id}
                        onLaunch={handleLaunchAgent}
                        onSelect={(id) => setSelectedAgentId(id)}
                      />
                    ))}
                    {showDeployForm ? (
                      <div className="aspect-[4/3] rounded-2xl border border-border/50 bg-bg/30 p-8 flex flex-col items-center justify-center text-center">
                        <div className="w-full space-y-3">
                          <input
                            placeholder={t("elizaclouddashboard.AgentName")}
                            value={deployAgentName}
                            onChange={(e) => setDeployAgentName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleDeployAgent();
                              if (e.key === "Escape") setShowDeployForm(false);
                            }}
                            disabled={deploying}
                            className="w-full h-8 px-3 rounded-xl bg-bg/50 border border-border/40 text-xs text-center focus:outline-none focus:border-accent"
                          />
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="flex-1 rounded-xl h-8 text-xs text-muted hover:text-txt-strong flex items-center justify-center p-0"
                              onClick={() => setShowDeployForm(false)}
                              disabled={deploying}
                            >
                              {t("onboarding.cancel")}
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              className="flex-1 rounded-xl h-8 text-xs font-bold"
                              onClick={handleDeployAgent}
                              disabled={deploying || !deployAgentName.trim()}
                            >
                              {deploying ? (
                                <Loader2 className="w-3 h-3 animate-spin mx-auto" />
                              ) : (
                                t("elizaclouddashboard.Deploy")
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="aspect-[4/3] rounded-2xl border border-dashed border-border/60 flex flex-col items-center justify-center p-8 lg:p-12 text-center group hover:border-accent/50 hover:bg-accent/5 transition-all duration-300 cursor-pointer"
                        onClick={() => setShowDeployForm(true)}
                      >
                        <div className="w-12 h-12 lg:w-10 lg:h-10 rounded-full bg-bg-accent flex items-center justify-center mb-5 lg:mb-6 group-hover:scale-110 transition-transform">
                          <Plus className="w-6 h-6 lg:w-5 lg:h-5 text-muted group-hover:text-txt" />
                        </div>
                        <h3 className="font-bold text-txt-strong mb-2">
                          {t("elizaclouddashboard.DeployNewAgent")}
                        </h3>
                        <p className="text-xs text-muted max-w-[16rem]">
                          {t("elizaclouddashboard.InitializeInstance")}
                        </p>
                      </button>
                    )}
                  </>
                )}
              </div>
            </SectionCard>

            <SectionCard
              title={t("elizaclouddashboard.UsageMetrics")}
              description={t("elizaclouddashboard.UsageMetricsDesc")}
              className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl shadow-sm"
            >
              <div className="h-48 flex items-center justify-center text-muted italic text-sm border border-border/30 rounded-2xl bg-bg/20 mt-6 p-6">
                {t("elizaclouddashboard.MetricsPlaceholder")}
              </div>
            </SectionCard>
          </div>

          <div className="space-y-8">
            {selectedAgentId && selectedAgent ? (
              <AgentDetailSidebar
                agent={selectedAgent}
                onClose={() => setSelectedAgentId(null)}
              />
            ) : (
              <SectionCard
                title={t("elizaclouddashboard.AccountDetails")}
                className="border-border/50 bg-bg/40 backdrop-blur-xl rounded-3xl shadow-sm"
              >
                <div className="space-y-5 mt-4">
                  <div className="p-4 rounded-2xl bg-bg/30 border border-border/30">
                    <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-2 block">
                      {t("elizaclouddashboard.CloudUserID")}
                    </span>
                    <code className="text-xs text-txt-strong break-all font-mono">
                      {elizaCloudUserId ||
                        t("elizaclouddashboard.NotAvailable")}
                    </code>
                  </div>

                  <div className="rounded-2xl border border-accent/20 bg-accent/8 p-5">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
                      {t("elizaclouddashboard.AvailableBalance")}
                    </div>
                    <div
                      className={`mt-3 text-3xl font-bold ${creditStatusColor}`}
                    >
                      ${cloudBalance.toFixed(2)}
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      {creditStatusTone}
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    className="w-full justify-start rounded-2xl border-border/40 bg-bg/30 px-5 py-4 text-sm"
                    onClick={() => setState("cloudDashboardView", "billing")}
                  >
                    <CircleDollarSign className="mr-2 h-4 w-4" />
                    {t("elizaclouddashboard.CloudBilling")}
                  </Button>
                </div>
              </SectionCard>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={checkoutDialogOpen}
        onOpenChange={(open) => {
          setCheckoutDialogOpen(open);
          if (!open) {
            void fetchBillingData();
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("elizaclouddashboard.PayWithCard")}</DialogTitle>
          </DialogHeader>
          {checkoutSession?.clientSecret && checkoutSession.publishableKey ? (
            <StripeEmbeddedCheckout
              publishableKey={checkoutSession.publishableKey}
              clientSecret={checkoutSession.clientSecret}
            />
          ) : (
            <div className="rounded-2xl border border-border/40 bg-bg/25 px-4 py-5 text-sm text-muted">
              {t("elizaclouddashboard.CheckoutProviderNote")}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface StatusDetail {
  status?: string;
  databaseStatus?: string;
  lastHeartbeat?: string | number | Date | null;
}

function AgentDetailSidebar({
  agent,
  onClose,
}: {
  agent: CloudCompatAgent | undefined;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<string>("");
  const [statusDetail, setStatusDetail] = useState<StatusDetail | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agent) return;
    let mounted = true;

    const fetchDetails = async () => {
      try {
        const [statusRes, logsRes] = await Promise.all([
          client.getCloudCompatAgentStatus(agent.agent_id),
          client.getCloudCompatAgentLogs(agent.agent_id, 100),
        ]);

        if (!mounted) return;
        setStatusDetail(statusRes.data);
        setLogs(typeof logsRes.data === "string" ? logsRes.data : "");
      } catch {
        // Silently retry next tick
      }
    };

    void fetchDetails();
    const intId = setInterval(fetchDetails, 5000);
    return () => {
      mounted = false;
      clearInterval(intId);
    };
  }, [agent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rerun when logs update
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  if (!agent) return null;

  return (
    <div className="space-y-4 animate-in slide-in-from-right-8 duration-300">
      <SectionCard
        title="Agent Details"
        className="border-accent/40 bg-accent/5 backdrop-blur-xl rounded-3xl shadow-sm relative overflow-hidden"
      >
        <button
          type="button"
          className="absolute top-4 right-4 p-1 rounded-full hover:bg-bg/50 transition-colors text-muted hover:text-txt-strong"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </button>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 rounded-xl bg-bg/40 border border-border/40">
              <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-1 block">
                Status
              </span>
              <AgentStatusBadge status={statusDetail?.status || agent.status} />
            </div>
            <div className="p-3 rounded-xl bg-bg/40 border border-border/40">
              <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-1 block">
                DB Status
              </span>
              <span className="text-xs font-mono">
                {statusDetail?.databaseStatus || agent.database_status || "—"}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-bg/40 border border-border/40 col-span-2">
              <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-1 block">
                Heartbeat
              </span>
              <span className="text-xs font-mono">
                {statusDetail?.lastHeartbeat
                  ? new Date(statusDetail.lastHeartbeat).toLocaleString()
                  : agent.last_heartbeat_at
                    ? new Date(agent.last_heartbeat_at).toLocaleString()
                    : "No heartbeat yet"}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-bg/80 border border-border/40">
            <span className="text-[10px] text-muted uppercase font-bold tracking-wider mb-2 flex items-center gap-2">
              <Terminal className="w-3 h-3" /> Live Logs
            </span>
            <div className="h-64 overflow-y-auto custom-scrollbar bg-black/50 rounded-lg p-3 border border-border/20">
              <pre className="text-[10px] font-mono text-txt-strong/80 whitespace-pre-wrap break-all">
                {logs || "No logs available. Deploying..."}
                <div ref={logsEndRef} />
              </pre>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
