

import {
  AlertCircle,
  CircleDollarSign,
  CreditCard,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type CloudBillingCheckoutResponse,
  type CloudBillingSettings,
  type CloudBillingSummary,
  type CloudCompatAgent,
  client,
} from "../../api";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { StripeEmbeddedCheckout } from "../cloud/StripeEmbeddedCheckout";
import { AgentDetailSidebar, CloudAgentCard } from "./cloud-dashboard-panels";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Switch } from "@elizaos/ui";
import {
  autoTopUpFormReducer,
  BILLING_PRESET_AMOUNTS,
  buildAutoTopUpFormState,
  consumeManagedDiscordCallbackUrl,
  consumeManagedGithubCallbackUrl,
  ELIZA_CLOUD_INSTANCES_URL,
  ELIZA_CLOUD_WEB_URL,
  getBillingAutoTopUp,
  getBillingLimits,
  getCloudAuthToken,
  isRecord,
  normalizeBillingSettings,
  normalizeBillingSummary,
  readBoolean,
  readNumber,
  readString,
  resolveCheckoutUrl,
  resolveCloudAccountIdDisplay,
} from "./cloud-dashboard-utils";

export function CloudDashboard() {
  const {
    t,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    elizaCloudAuthRejected,
    elizaCloudTopUpUrl,
    elizaCloudUserId,
    elizaCloudStatusReason,
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
  const [_cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoQuote, setCryptoQuote] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [_cryptoPayBusy, setCryptoPayBusy] = useState(false);
  const [_cryptoPayResult, setCryptoPayResult] = useState<string | null>(null);
  const [cloudAgents, setCloudAgents] = useState<CloudCompatAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [cloudNotReady, setCloudNotReady] = useState(false);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null);
  const [openingWebUiAgentId, setOpeningWebUiAgentId] = useState<string | null>(
    null,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = cloudAgents.find((a) => a.agent_id === selectedAgentId);
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [deployAgentName, setDeployAgentName] = useState("");
  const [deploying, setDeploying] = useState(false);
  const mountedRef = useRef(true);
  const handledManagedDiscordCallbackRef = useRef(false);
  const handledManagedGithubCallbackRef = useRef(false);
  const autoTopUpEnabled = autoTopUpForm.enabled;
  const autoTopUpAmount = autoTopUpForm.amount;
  const autoTopUpThreshold = autoTopUpForm.threshold;

  const fetchCloudAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    setCloudNotReady(false);
    try {
      const data = await client.getCloudCompatAgents();
      if (!mountedRef.current) return;
      setCloudAgents(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg =
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToLoadCloudAgents", {
              defaultValue: "Failed to load cloud agents",
            });
      if (msg.includes("not available yet")) {
        setCloudNotReady(true);
      } else {
        setAgentsError(msg);
      }
      setCloudAgents([]);
    } finally {
      if (mountedRef.current) setAgentsLoading(false);
    }
  }, [t]);

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
          : new Error(
              t("elizaclouddashboard.BillingSummaryUnavailable", {
                defaultValue: "Billing summary unavailable.",
              }),
            );
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
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToLoadBillingData", {
              defaultValue: "Failed to load billing data.",
            }),
      );
    } finally {
      if (mountedRef.current) {
        setBillingLoading(false);
      }
    }
  }, [t]);

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

  const _handleLaunchAgent = useCallback(
    async (agentId: string) => {
      setLaunchingAgentId(agentId);
      try {
        const response = await client.launchCloudCompatAgent(agentId);
        if (!response.success || !response.data?.connection?.apiBase) {
          throw new Error(
            t("elizaclouddashboard.LaunchConnectionMissing", {
              defaultValue: "Eliza Cloud did not return a launch connection.",
            }),
          );
        }

        const { connection } = response.data;
        client.setBaseUrl(connection.apiBase);
        client.setToken(connection.token);
        setState("startupError", null);
        setState("onboardingServerTarget", "elizacloud");
        setState("onboardingRemoteApiBase", connection.apiBase);
        setState("onboardingRemoteToken", connection.token);
        setState("onboardingRemoteError", null);
        setState("onboardingRemoteConnecting", false);
        setState("onboardingRemoteConnected", false);
        setActionNotice(
          t("elizaclouddashboard.OpenedManagedInstance", {
            defaultValue: "Opened managed Eliza Cloud instance.",
          }),
          "success",
          3000,
        );
        setTab("chat");
        retryStartup();
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("elizaclouddashboard.FailedToOpenInstance", {
                defaultValue: "Failed to open Eliza Cloud instance.",
              }),
          "error",
          4200,
        );
      } finally {
        if (mountedRef.current) {
          setLaunchingAgentId(null);
        }
      }
    },
    [retryStartup, setActionNotice, setState, setTab, t],
  );

  const handleOpenWebUI = useCallback(
    async (agentId: string) => {
      // Open a blank tab immediately (must be synchronous to avoid popup blockers)
      const tab = window.open("", "_blank");
      if (!tab) {
        setActionNotice(
          t("elizaclouddashboard.PopupBlocked", {
            defaultValue: "Popup blocked. Please allow popups and try again.",
          }),
          "error",
          4200,
        );
        return;
      }

      setOpeningWebUiAgentId(agentId);
      try {
        // Try local backend proxy first, then direct cloud call
        let redirectUrl: string | undefined;

        // Try local backend proxy first
        try {
          const response = await client.getCloudCompatPairingToken(agentId);
          redirectUrl = response?.data?.redirectUrl;
        } catch {
          // proxy failed, fall through to direct call
        }

        // If proxy failed, try direct cloud call
        if (!redirectUrl) {
          const cloudBase = "https://www.elizacloud.ai";
          const token =
            getCloudAuthToken() || client.getRestAuthToken?.() || "";
          try {
            const directRes = await fetch(
              `${cloudBase}/api/v1/app/agents/${encodeURIComponent(agentId)}/pairing-token`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "X-Api-Key": token,
                },
              },
            );
            if (directRes.ok) {
              const json = await directRes.json();
              redirectUrl = json?.data?.redirectUrl ?? json?.redirectUrl;
            }
          } catch {
            // direct fetch failed, redirectUrl remains unset
          }
        }

        if (!redirectUrl)
          throw new Error("No redirectUrl from proxy or direct call");
        if (!tab.closed) tab.location.href = redirectUrl;
      } catch {
        // Fallback: open the agent's web UI URL directly
        const agent = cloudAgents.find((a) => a.agent_id === agentId);
        const fallbackUrl = agent?.webUiUrl ?? agent?.web_ui_url;
        if (fallbackUrl) {
          if (!tab.closed) tab.location.href = fallbackUrl;
        } else {
          tab.close();
          setActionNotice(
            t("elizaclouddashboard.FailedToOpenWebUI", {
              defaultValue: "Failed to open Web UI for this agent.",
            }),
            "error",
            4200,
          );
        }
      } finally {
        if (mountedRef.current) {
          setOpeningWebUiAgentId(null);
        }
      }
    },
    [cloudAgents, setActionNotice, t],
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
        t("elizaclouddashboard.AutoTopUpAmountRange", {
          defaultValue:
            "Auto top-up amount must be between ${{min}} and ${{max}}.",
          min: minAmount,
          max: maxAmount,
        }),
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
        t("elizaclouddashboard.AutoTopUpThresholdRange", {
          defaultValue:
            "Auto top-up threshold must be between ${{min}} and ${{max}}.",
          min: minThreshold,
          max: maxThreshold,
        }),
        "error",
        3600,
      );
      return;
    }

    if (autoTopUpEnabled && !hasPaymentMethod) {
      setActionNotice(
        t("elizaclouddashboard.SavePaymentMethodBeforeAutoTopUp", {
          defaultValue: "Add a card first",
        }),
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
      setActionNotice(
        t("elizaclouddashboard.BillingSettingsUpdated", {
          defaultValue: "Billing settings updated.",
        }),
        "success",
        3200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToUpdateBillingSettings", {
              defaultValue: "Failed to update billing settings.",
            }),
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
    t,
  ]);

  const handleStartCheckout = useCallback(async () => {
    const minimumTopUp =
      readNumber(
        (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
      ) ?? 1;
    const amountUsd = Number(billingAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
      setActionNotice(
        t("elizaclouddashboard.EnterTopUpAmountMinimum", {
          defaultValue: "Enter a top-up amount of at least ${{amount}}.",
          amount: minimumTopUp,
        }),
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
        t("elizaclouddashboard.CheckoutSessionMissing", {
          defaultValue:
            "Checkout unavailable. Try again or use the billing portal.",
        }),
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToStartCheckout", {
              defaultValue: "Failed to start checkout.",
            }),
        "error",
        4200,
      );
    } finally {
      setCheckoutBusy(false);
    }
  }, [billingAmount, billingSummary, setActionNotice, t]);

  const _handleCreateCryptoQuote = useCallback(async () => {
    const minimumTopUp =
      readNumber(
        (billingSummary as Record<string, unknown> | null)?.minimumTopUp,
      ) ?? 1;
    const amountUsd = Number(billingAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < minimumTopUp) {
      setActionNotice(
        t("elizaclouddashboard.EnterTopUpAmountMinimum", {
          defaultValue: "Enter a top-up amount of at least ${{amount}}.",
          amount: minimumTopUp,
        }),
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
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.FailedToRequestCryptoQuote", {
              defaultValue: "Failed to request crypto quote.",
            }),
        "error",
        4200,
      );
    } finally {
      setCryptoBusy(false);
    }
  }, [billingAmount, billingSummary, setActionNotice, walletAddresses, t]);

  const _handlePayCryptoFromAgentWallet = useCallback(async () => {
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
        t("elizaclouddashboard.BscOnlyAgentWalletPayment", {
          defaultValue:
            "Agent-wallet payment is currently wired for BSC quotes only.",
        }),
        "info",
        4200,
      );
      return;
    }

    if (!payToAddress || !amount) {
      setActionNotice(
        t("elizaclouddashboard.CryptoQuoteMissingTransferDetails", {
          defaultValue: "Crypto quote is missing transfer details.",
        }),
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
        const stewardNote =
          result.mode === "steward"
            ? t("elizaclouddashboard.ViaStewardVault", {
                defaultValue: " (via Steward vault)",
              })
            : "";
        setCryptoPayResult(
          t("elizaclouddashboard.SubmittedPayment", {
            defaultValue: "Submitted {{currency}} payment: {{hash}}{{note}}",
            currency,
            hash: result.execution.hash,
            note: stewardNote,
          }),
        );
        setActionNotice(
          t("elizaclouddashboard.CryptoPaymentSubmitted", {
            defaultValue:
              "Crypto payment submitted from the agent wallet{{note}}.",
            note: stewardNote,
          }),
          "success",
        );
      } else if (result.mode === "steward" && !result.requiresUserSignature) {
        const execStatus = result.execution?.status;
        if (execStatus === "pending_approval") {
          setCryptoPayResult(
            t("elizaclouddashboard.TransferAwaitingApproval", {
              defaultValue: "Transfer is waiting for Steward policy approval.",
            }),
          );
          setActionNotice(
            t("elizaclouddashboard.TransactionPendingApproval", {
              defaultValue: "Transaction pending Steward policy approval.",
            }),
            "info",
            6000,
          );
        } else if (!result.ok || execStatus === "rejected") {
          const reason =
            result.execution?.policyResults?.find((p) => p.reason)?.reason ??
            result.error ??
            t("elizaclouddashboard.PolicyRejected", {
              defaultValue: "Policy rejected",
            });
          setCryptoPayResult(
            t("elizaclouddashboard.StewardPolicyRejected", {
              defaultValue: "Steward policy rejected: {{reason}}",
              reason,
            }),
          );
          setActionNotice(
            t("elizaclouddashboard.StewardPolicyRejectedTransfer", {
              defaultValue: "Steward policy rejected the transfer: {{reason}}",
              reason,
            }),
            "error",
            6000,
          );
        }
      } else if (result.requiresUserSignature) {
        setCryptoPayResult(
          t("elizaclouddashboard.UnsignedPaymentRequest", {
            defaultValue:
              "Cloud returned an unsigned payment request. Sign it from the wallet flow to complete payment.",
          }),
        );
        setActionNotice(
          t("elizaclouddashboard.RequiresUserSignMode", {
            defaultValue:
              "This wallet requires user-sign mode for crypto payment.",
          }),
          "info",
          4200,
        );
      }
    } catch (err) {
      setCryptoPayResult(null);
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("elizaclouddashboard.CryptoPaymentFailed", {
              defaultValue: "Crypto payment failed.",
            }),
        "error",
        4200,
      );
    } finally {
      setCryptoPayBusy(false);
    }
  }, [cryptoQuote, setActionNotice, t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleLearnMoreElizaCloud = useCallback(async () => {
    await openExternalUrl(ELIZA_CLOUD_WEB_URL);
  }, []);

  useEffect(() => {
    if (elizaCloudConnected) {
      void loadDropStatus();
      void fetchCloudAgents();
      void fetchBillingData();
    }
  }, [fetchBillingData, fetchCloudAgents, loadDropStatus, elizaCloudConnected]);

  useEffect(() => {
    if (
      handledManagedDiscordCallbackRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }

    const { callback, cleanedUrl } = consumeManagedDiscordCallbackUrl(
      window.location.href,
    );
    if (!callback) {
      return;
    }

    handledManagedDiscordCallbackRef.current = true;
    setState("cloudDashboardView", "agents");
    if (callback.agentId) {
      setSelectedAgentId(callback.agentId);
    }
    if (cleanedUrl && cleanedUrl !== window.location.href) {
      window.history.replaceState({}, document.title, cleanedUrl);
    }

    if (callback.status === "connected") {
      setActionNotice(
        callback.guildName
          ? t("elizaclouddashboard.ManagedDiscordConnectedNotice", {
              defaultValue: callback.restarted
                ? "Managed Discord connected to {{guild}}. The agent restarted and is ready."
                : "Managed Discord connected to {{guild}}.",
              guild: callback.guildName,
            })
          : t("elizaclouddashboard.ManagedDiscordConnectedNoticeFallback", {
              defaultValue: callback.restarted
                ? "Managed Discord connected. The agent restarted and is ready."
                : "Managed Discord connected.",
            }),
        "success",
        5200,
      );
      void fetchCloudAgents();
      return;
    }

    setActionNotice(
      callback.message ||
        t("elizaclouddashboard.ManagedDiscordConnectFailed", {
          defaultValue: "Managed Discord setup did not complete.",
        }),
      "error",
      5200,
    );
  }, [fetchCloudAgents, setActionNotice, setState, t]);

  // Handle GitHub OAuth callback — link the connection to the agent
  useEffect(() => {
    if (
      handledManagedGithubCallbackRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }

    const { callback, cleanedUrl } = consumeManagedGithubCallbackUrl(
      window.location.href,
    );
    if (!callback) {
      return;
    }

    handledManagedGithubCallbackRef.current = true;
    setState("cloudDashboardView", "agents");
    if (callback.agentId) {
      setSelectedAgentId(callback.agentId);
    }
    if (cleanedUrl && cleanedUrl !== window.location.href) {
      window.history.replaceState({}, document.title, cleanedUrl);
    }

    if (callback.status === "connected") {
      // Server-side completion endpoint already linked the connection;
      // just show a success notice and refresh agent list.
      setActionNotice(
        t("elizaclouddashboard.ManagedGithubConnectedNotice", {
          defaultValue: "GitHub account connected to this agent.",
        }),
        "success",
        5200,
      );
      void fetchCloudAgents();
      return;
    }

    setActionNotice(
      callback.message ||
        t("elizaclouddashboard.ManagedGithubConnectFailed", {
          defaultValue: "GitHub setup did not complete.",
        }),
      "error",
      5200,
    );
  }, [fetchCloudAgents, setActionNotice, setState, t]);

  // Drop cached billing / agents when disconnected so we never show stale balances
  // after context clears credits (local state would otherwise outlive AppContext).
  useEffect(() => {
    if (elizaCloudConnected) return;
    setBillingSummary(null);
    setBillingSettings(null);
    setBillingError(null);
    setCloudAgents([]);
    setAgentsError(null);
    setAgentsLoading(false);
    setDeletingAgentId(null);
    setLaunchingAgentId(null);
    setSelectedAgentId(null);
    setShowDeployForm(false);
    setDeployAgentName("");
    setCheckoutSession(null);
    setCheckoutDialogOpen(false);
    setCryptoQuote(null);
    setCryptoPayResult(null);
    dispatchAutoTopUpForm({
      type: "hydrate",
      next: buildAutoTopUpFormState(null, null),
      force: true,
    });
  }, [elizaCloudConnected]);

  const summaryCritical =
    elizaCloudAuthRejected ||
    (billingSummary?.critical ?? elizaCloudCreditsCritical ?? false);
  const summaryLow = billingSummary?.low ?? elizaCloudCreditsLow ?? false;
  const creditStatusColor = summaryCritical
    ? "text-danger"
    : summaryLow
      ? "text-warn"
      : "text-ok";
  const activeView = cloudDashboardView;
  const cloudBalanceNumber =
    typeof elizaCloudCredits === "number"
      ? elizaCloudCredits
      : typeof billingSummary?.balance === "number"
        ? billingSummary.balance
        : null;
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
  const creditStatusTone = elizaCloudAuthRejected
    ? t("notice.elizaCloudAuthRejected")
    : summaryCritical
      ? t("elizaclouddashboard.CreditsCritical")
      : summaryLow
        ? t("elizaclouddashboard.CreditsLow")
        : t("elizaclouddashboard.CreditsHealthy");
  const cloudAccountIdDisplay = resolveCloudAccountIdDisplay(
    elizaCloudUserId,
    elizaCloudStatusReason,
    t,
  );
  const _hasAgentWallet = Boolean(
    walletAddresses?.evmAddress || walletAddresses?.solanaAddress,
  );
  const _hasWalletFunds = Boolean(
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
          onClick={() => { void handleCloudLogin(); }}
          disabled={elizaCloudLoginBusy}
        >
          {elizaCloudLoginBusy ? (
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Zap className="w-4 h-4 mr-2" />
          )}
          {elizaCloudLoginBusy
            ? t("onboarding.connecting")
            : t("elizaclouddashboard.ConnectElizaCloud")}
        </Button>
        <p className="mt-4 text-xs text-muted/60">
          {t("elizaclouddashboard.NewToElizaCloud")}{" "}
          <Button
            variant="link"
            className="p-0 h-auto font-inherit text-xs align-baseline"
            onClick={() => void handleLearnMoreElizaCloud()}
          >
            {t("elizaclouddashboard.LearnMore")}
          </Button>
        </p>
      </div>
    );
  }

  return (
    <div className="custom-scrollbar p-4 lg:p-6 space-y-4 max-w-7xl mx-auto animate-in fade-in duration-500">
      {elizaCloudAuthRejected ? (
        <div
          className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          role="alert"
        >
          {t("notice.elizaCloudAuthRejected")}
        </div>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-lg font-bold text-txt-strong tracking-tight">
            {t("elizaclouddashboard.CloudDashboard")}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/50 bg-bg/50 p-0.5">
            <Button
              variant={activeView === "billing" ? "default" : "ghost"}
              size="sm"
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${
                activeView !== "billing"
                  ? "text-muted-strong hover:text-txt"
                  : "text-txt-strong hover:text-txt-strong"
              }`}
              onClick={() => setState("cloudDashboardView", "billing")}
            >
              <CircleDollarSign className="w-3.5 h-3.5" />
              {t("elizaclouddashboard.Billing", {
                defaultValue: "Billing",
              })}
            </Button>
            <Button
              variant={activeView === "agents" ? "default" : "ghost"}
              size="sm"
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${
                activeView !== "agents"
                  ? "text-muted-strong hover:text-txt"
                  : "text-txt-strong hover:text-txt-strong"
              }`}
              onClick={() => setState("cloudDashboardView", "agents")}
            >
              <Server className="w-3.5 h-3.5" />
              {t("elizaclouddashboard.Agents", {
                defaultValue: "Agents",
              })}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg border-border/50 h-8 text-xs"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("common.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-lg border-danger/30 text-danger hover:bg-danger/10 h-8 text-xs"
            onClick={() => void handleCloudDisconnect()}
            disabled={cloudDisconnecting}
          >
            {cloudDisconnecting
              ? t("providerswitcher.disconnecting")
              : t("providerswitcher.disconnect")}
          </Button>
        </div>
      </div>

      {activeView === "billing" ? (
        <div className="mx-auto max-w-3xl space-y-0">
          <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-baseline gap-3">
              <span
                className={`text-3xl font-bold tracking-tight ${creditStatusColor}`}
              >
                {cloudCurrency === "USD" ? "$" : `${cloudCurrency} `}
                {cloudBalanceNumber !== null ? (
                  cloudBalanceNumber.toFixed(2)
                ) : (
                  <span className="text-muted">
                    {billingLoading ? "…" : "—"}
                  </span>
                )}
              </span>
              <span className="text-sm text-muted">
                {t("elizaclouddashboard.CreditsLabel", {
                  defaultValue: "credits",
                })}
              </span>
              {billingLoading && (
                <Loader2 className="h-4 w-4 animate-spin text-muted" />
              )}
            </div>
            <span
              className={`w-fit rounded-full border px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
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

          {billingError && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger mb-4">
              {billingError}
            </div>
          )}

          <div className="py-1" />
          <div className="py-5">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-sm font-semibold text-txt-strong">
                {t("elizaclouddashboard.TopUpCredits")}
              </h3>
              {fallbackBillingUrl ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted hover:text-txt h-auto p-0"
                  onClick={() => void openExternalUrl(fallbackBillingUrl)}
                >
                  <ExternalLink className="mr-1.5 h-3 w-3" />
                  {t("elizaclouddashboard.OpenBrowserBilling")}
                </Button>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div
                className={"rounded-xl border border-border/50 bg-bg/30 p-4"}
              >
                <div className="flex items-center gap-2 mb-3">
                  <CreditCard className="h-4 w-4 text-muted" />
                  <span className="text-xs font-semibold">
                    {t("elizaclouddashboard.PayWithCard")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {BILLING_PRESET_AMOUNTS.map((amount) => (
                    <Button
                      key={amount}
                      variant={
                        billingAmount === String(amount) ? "default" : "outline"
                      }
                      size="sm"
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                        billingAmount !== String(amount)
                          ? "border-border/50 bg-bg/40 text-txt hover:border-accent/40"
                          : "text-txt-strong hover:text-txt-strong"
                      }`}
                      onClick={() => setBillingAmount(String(amount))}
                    >
                      ${amount}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    id="cloud-billing-amount"
                    type="number"
                    min={String(minimumTopUp)}
                    step="1"
                    value={billingAmount}
                    onChange={(e) => setBillingAmount(e.target.value)}
                    className="rounded-lg bg-bg text-sm h-9 flex-1"
                    placeholder={t("elizaclouddashboard.MinAmountPlaceholder", {
                      defaultValue: "Min ${{amount}}",
                      amount: minimumTopUp.toFixed(2),
                    })}
                  />
                  <Button
                    variant="default"
                    className="rounded-lg font-semibold h-9 px-4 text-txt-strong hover:text-txt-strong"
                    disabled={checkoutBusy || billingLoading}
                    onClick={() => void handleStartCheckout()}
                  >
                    {checkoutBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      t("elizaclouddashboard.Pay", { defaultValue: "Pay" })
                    )}
                  </Button>
                </div>
              </div>
              <div
                className={"rounded-xl border border-border/50 bg-bg/30 p-4"}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Wallet className="h-4 w-4 text-muted" />
                  <span className="text-xs font-semibold">
                    {t("elizaclouddashboard.PayWithCrypto")}
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="w-full rounded-lg h-9"
                  onClick={() =>
                    void openExternalUrl(
                      "https://www.elizacloud.ai/dashboard/settings?tab=billing",
                    )
                  }
                >
                  <ExternalLink className="mr-1.5 h-3 w-3" />
                  {t("elizaclouddashboard.PayWithCrypto")}
                </Button>
              </div>
            </div>
          </div>

          <div className="py-1" />
          <div className="py-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-txt-strong">
                  {t("elizaclouddashboard.AutoTopUp")}
                </h3>
                <p className="text-xs-tight text-muted mt-0.5">
                  {autoTopUpHasPaymentMethod
                    ? t("elizaclouddashboard.AutoTopUpPaymentReady", {
                        defaultValue: "Card saved",
                      })
                    : t("elizaclouddashboard.AutoTopUpNeedsPaymentMethod", {
                        defaultValue: "Add a card first",
                      })}
                </p>
              </div>
              <Switch
                checked={autoTopUpEnabled}
                onCheckedChange={(v: boolean) =>
                  dispatchAutoTopUpForm({ type: "setEnabled", value: v })
                }
                aria-label={t("elizaclouddashboard.ToggleAutoTopUp")}
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <label
                  htmlFor="cloud-auto-topup-threshold"
                  className="text-xs-tight text-muted"
                >
                  {t("elizaclouddashboard.RefillWhenBelow", {
                    defaultValue: "Refill when below",
                  })}
                </label>
                <Input
                  id="cloud-auto-topup-threshold"
                  type="number"
                  min={String(autoTopUpMinThreshold)}
                  max={String(autoTopUpMaxThreshold)}
                  step="1"
                  value={autoTopUpThreshold}
                  onChange={(e) =>
                    dispatchAutoTopUpForm({
                      type: "setThreshold",
                      value: e.target.value,
                    })
                  }
                  className="rounded-lg bg-bg h-9"
                />
              </div>
              <div className="flex-1 space-y-1">
                <label
                  htmlFor="cloud-auto-topup-amount"
                  className="text-xs-tight text-muted"
                >
                  {t("elizaclouddashboard.TopUpAmount", {
                    defaultValue: "Top-up amount",
                  })}
                </label>
                <Input
                  id="cloud-auto-topup-amount"
                  type="number"
                  min={String(autoTopUpMinAmount)}
                  max={String(autoTopUpMaxAmount)}
                  step="1"
                  value={autoTopUpAmount}
                  onChange={(e) =>
                    dispatchAutoTopUpForm({
                      type: "setAmount",
                      value: e.target.value,
                    })
                  }
                  className="rounded-lg bg-bg h-9"
                />
              </div>
              <Button
                variant="outline"
                className="h-9 rounded-lg px-4 sm:self-end"
                disabled={
                  billingSettingsBusy || billingLoading || !autoTopUpForm.dirty
                }
                onClick={() => void handleSaveBillingSettings()}
              >
                {billingSettingsBusy ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : null}
                {t("apikeyconfig.save")}
              </Button>
            </div>
          </div>

          <div className="py-1" />
          <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-ok shrink-0" />
                <span className="text-2xs px-2 py-0.5 rounded-full bg-ok/10 text-ok font-bold uppercase tracking-wider border border-ok/20">
                  {t("elizaclouddashboard.Secure")}
                </span>
              </div>
              {cloudAccountIdDisplay.mono ? (
                <code className="break-all font-mono text-xs-tight text-muted">
                  {cloudAccountIdDisplay.text}
                </code>
              ) : (
                <span className="break-words text-xs-tight text-muted leading-snug">
                  {cloudAccountIdDisplay.text}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted hover:text-txt h-auto p-0 shrink-0"
              onClick={() => void openExternalUrl(ELIZA_CLOUD_INSTANCES_URL)}
            >
              {t("elizaclouddashboard.AdvancedDashboard")}
              <ExternalLink className="w-3 h-3 ml-1.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-3xl space-y-0">
          {cloudNotReady && (
            <div className="flex flex-col items-center justify-center py-12 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center mb-4 border border-accent/20">
                <Server className="w-5 h-5 text-accent" />
              </div>
              <p className="text-sm font-medium text-txt mb-1.5">
                {t("elizaclouddashboard.CloudAgentsComingSoon", {
                  defaultValue: "Cloud Agents Coming Soon",
                })}
              </p>
              <p className="text-xs text-muted text-center max-w-xs leading-relaxed">
                Coming soon.
              </p>
            </div>
          )}
          {agentsError && !cloudNotReady && (
            <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger mb-3">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {agentsError}
            </div>
          )}
          <div className="flex flex-col gap-3 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {cloudAccountIdDisplay.mono ? (
                <code className="max-w-full break-all font-mono text-muted sm:max-w-[200px] sm:truncate">
                  {cloudAccountIdDisplay.text}
                </code>
              ) : (
                <span className="max-w-full break-words text-muted text-xs-tight leading-snug sm:max-w-[min(100%,280px)]">
                  {cloudAccountIdDisplay.text}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`font-semibold ${creditStatusColor}`}>
                {cloudBalanceNumber !== null ? (
                  `$${cloudBalanceNumber.toFixed(2)}`
                ) : (
                  <span className="text-muted">
                    {billingLoading ? "…" : "—"}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted hover:text-txt h-auto p-0"
                onClick={() => setState("cloudDashboardView", "billing")}
              >
                <CircleDollarSign className="mr-1 h-3 w-3" />
                {t("elizaclouddashboard.Billing", {
                  defaultValue: "Billing",
                })}
              </Button>
            </div>
          </div>

          <div className="py-1" />
          {!cloudNotReady && (
            <div className="py-4">
              {agentsLoading && cloudAgents.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 text-muted animate-spin" />
                </div>
              ) : (
                <div className="space-y-2">
                  {cloudAgents.map((agent) => (
                    <CloudAgentCard
                      key={agent.agent_id}
                      agent={agent}
                      onDelete={handleDeleteAgent}
                      deleting={deletingAgentId === agent.agent_id}
                      launching={launchingAgentId === agent.agent_id}
                      onLaunch={handleOpenWebUI}
                      onOpenUI={handleOpenWebUI}
                      openingUI={openingWebUiAgentId === agent.agent_id}
                      onSelect={(id) => setSelectedAgentId(id)}
                      selected={selectedAgentId === agent.agent_id}
                    />
                  ))}

                  {showDeployForm ? (
                    <div className="rounded-2xl border border-border/60 bg-card/88 p-4 shadow-sm flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
                      <Input
                        placeholder={t("elizaclouddashboard.AgentName")}
                        value={deployAgentName}
                        onChange={(e) => setDeployAgentName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleDeployAgent();
                          if (e.key === "Escape") setShowDeployForm(false);
                        }}
                        disabled={deploying}
                        className="h-9 flex-1 rounded-lg bg-bg text-xs"
                      />
                      <Button
                        size="sm"
                        className="h-9 rounded-lg text-xs"
                        onClick={handleDeployAgent}
                        disabled={deploying || !deployAgentName.trim()}
                      >
                        {deploying ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          t("elizaclouddashboard.Deploy")
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 rounded-lg text-xs text-muted-strong"
                        onClick={() => setShowDeployForm(false)}
                        disabled={deploying}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      className="rounded-2xl border border-border/60 bg-card/88 p-4 shadow-sm h-auto w-full justify-start gap-2 py-3 text-xs text-muted-strong hover:text-txt"
                      onClick={() => setShowDeployForm(true)}
                    >
                      <Plus className="w-4 h-4" />
                      {t("elizaclouddashboard.DeployNewAgent")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {selectedAgentId && selectedAgent && (
            <>
              <div className="py-1" />
              <AgentDetailSidebar
                agent={selectedAgent}
                onClose={() => setSelectedAgentId(null)}
              />
            </>
          )}
        </div>
      )}

      <Dialog
        open={checkoutDialogOpen}
        onOpenChange={(open: boolean) => {
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
