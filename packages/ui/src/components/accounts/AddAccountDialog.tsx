/**
 * Provider-aware account enrollment for API keys and first-party coding
 * subscriptions. OAuth state persists across browser handoffs and is observed
 * through the server status stream; subscription credentials remain confined
 * to their supported coding surfaces.
 */

import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
} from "@elizaos/shared";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { navigatePreOpenedWindow, preOpenWindow } from "../../utils";
import { copyTextToClipboard } from "../../utils/clipboard";
import { openEventSource } from "../../utils/event-source";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { ProviderPicker } from "./ProviderPicker";
import { subscriptionOAuthModeForHostname } from "./subscription-oauth-mode";
import {
  clearSubscriptionOAuth,
  readSubscriptionOAuth,
  writeSubscriptionOAuth,
} from "./subscription-oauth-state";

interface AddAccountDialogProps {
  open: boolean;
  /** Optional initial provider. When omitted, the dialog starts with the consolidated provider picker. */
  providerId?: LinkedAccountProviderId;
  /** Unhealthy account whose credential is replaced in place after verification. */
  credentialRepairAccount?: Pick<
    LinkedAccountConfig,
    "id" | "label" | "source" | "health"
  > | null;
  onClose: () => void;
  onCreated: (account: LinkedAccountConfig) => void;
}

type DialogStep =
  | "provider-select"
  | "choose"
  | "oauth-starting"
  | "oauth-waiting"
  | "oauth-need-code"
  | "apikey"
  | "apikey-submitting"
  | "unavailable"
  | "error";

interface SseFlowState {
  status: "pending" | "success" | "error" | "cancelled" | "timeout";
  account?: LinkedAccountConfig;
  error?: string;
}

type SubscriptionAddMode =
  | "oauth"
  | "api-key"
  | "external-cli"
  | "unavailable"
  | "none";

// The static provider catalog + its types now live in their own module so
// presentational pieces can import them without a circular dependency on this
// dialog. Re-exported here for backward compatibility.
export {
  ACCOUNT_PROVIDER_OPTIONS,
  type AccountProviderCategory,
  type AccountProviderOption,
  getAccountProviderOption,
} from "./account-provider-options";

const SUBSCRIPTION_ADD_MODE_BY_PROVIDER: Partial<
  Record<LinkedAccountProviderId, SubscriptionAddMode>
> = {
  "anthropic-subscription": "oauth",
  "openai-codex": "oauth",
  "gemini-cli": "external-cli",
  "zai-coding": "api-key",
  "kimi-coding": "api-key",
  "deepseek-coding": "unavailable",
};

function getSubscriptionAddMode(
  providerId: LinkedAccountProviderId,
): SubscriptionAddMode {
  return SUBSCRIPTION_ADD_MODE_BY_PROVIDER[providerId] ?? "none";
}

function initialStepForProvider(
  providerId: LinkedAccountProviderId,
): DialogStep {
  const mode = getSubscriptionAddMode(providerId);
  if (mode === "oauth") return "choose";
  if (mode === "external-cli" || mode === "unavailable") return "unavailable";
  return "apikey";
}

function defaultOAuthLabel(providerId: LinkedAccountProviderId): string {
  if (providerId === "anthropic-subscription") return "Claude account";
  if (providerId === "openai-codex") return "Codex account";
  if (getSubscriptionAddMode(providerId) === "api-key") {
    return "Coding plan account";
  }
  return "API account";
}

function providerDisplayName(
  providerId: LinkedAccountProviderId,
  t: (k: string, v?: Record<string, unknown>) => string,
): string {
  switch (providerId) {
    case "anthropic-subscription":
      return t("accounts.provider.anthropicSubscription", {
        defaultValue: "Anthropic Claude subscription",
      });
    case "openai-codex":
      return t("accounts.provider.openaiCodex", {
        defaultValue: "OpenAI Codex subscription",
      });
    case "gemini-cli":
      return t("accounts.provider.geminiCli", {
        defaultValue: "Gemini CLI subscription",
      });
    case "zai-coding":
      return t("accounts.provider.zaiCoding", {
        defaultValue: "z.ai Coding Plan",
      });
    case "kimi-coding":
      return t("accounts.provider.kimiCoding", {
        defaultValue: "Kimi Code",
      });
    case "deepseek-coding":
      return t("accounts.provider.deepseekCoding", {
        defaultValue: "DeepSeek coding subscription",
      });
    case "anthropic-api":
      return t("accounts.provider.anthropicApi", {
        defaultValue: "Anthropic API",
      });
    case "openai-api":
      return t("accounts.provider.openaiApi", {
        defaultValue: "OpenAI API",
      });
    case "deepseek-api":
      return t("accounts.provider.deepseekApi", {
        defaultValue: "DeepSeek API",
      });
    case "zai-api":
      return t("accounts.provider.zaiApi", {
        defaultValue: "z.ai API",
      });
    case "moonshot-api":
      return t("accounts.provider.moonshotApi", {
        defaultValue: "Kimi / Moonshot API",
      });
    case "cerebras-api":
      return t("accounts.provider.cerebrasApi", {
        defaultValue: "Cerebras API",
      });
    default:
      return providerId;
  }
}

export function AddAccountDialog({
  open,
  providerId,
  credentialRepairAccount = null,
  onClose,
  onCreated,
}: AddAccountDialogProps) {
  const t = useAppSelector((s) => s.t);
  const [selectedProviderId, setSelectedProviderId] =
    useState<LinkedAccountProviderId | null>(providerId ?? null);
  const activeProviderId = selectedProviderId ?? providerId ?? null;
  const subscriptionAddMode = activeProviderId
    ? getSubscriptionAddMode(activeProviderId)
    : "none";

  const [step, setStep] = useState<DialogStep>(
    activeProviderId
      ? initialStepForProvider(activeProviderId)
      : "provider-select",
  );
  const [label, setLabel] = useState(
    () =>
      credentialRepairAccount?.label ??
      (activeProviderId ? defaultOAuthLabel(activeProviderId) : ""),
  );
  const [apiKey, setApiKey] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  // The sign-in URL shown for the user to open MANUALLY (Codex device
  // verification URL, or Anthropic's claude.ai authorize URL). Only the Codex
  // localhost-callback flow auto-opens a window; every other flow shows this
  // link so the user opens it wherever they want (a second device / browser).
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const restoredSessionRef = useRef<string | null>(null);
  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cancelInflightFlow = useCallback(async () => {
    closeEventSource();
    const id = sessionIdRef.current;
    if (id && activeProviderId) {
      sessionIdRef.current = null;
      try {
        await client.cancelAccountOAuth(activeProviderId, { sessionId: id });
      } catch {
        // error-policy:J6 The server independently expires abandoned OAuth flows.
      }
    }
  }, [closeEventSource, activeProviderId]);

  const reset = useCallback(() => {
    closeEventSource();
    sessionIdRef.current = null;
    restoredSessionRef.current = null;
    setStep(
      activeProviderId
        ? initialStepForProvider(activeProviderId)
        : "provider-select",
    );
    setLabel(
      credentialRepairAccount?.id
        ? credentialRepairAccount.label
        : activeProviderId
          ? defaultOAuthLabel(activeProviderId)
          : "",
    );
    setApiKey("");
    setOauthCode("");
    setErrorMessage(null);
    setSessionId(null);
    setDeviceCode(null);
    setDeviceCodeCopied(false);
    setOauthUrl(null);
  }, [
    closeEventSource,
    activeProviderId,
    credentialRepairAccount?.id,
    credentialRepairAccount?.label,
  ]);

  const copyDeviceCode = useCallback(async (code: string) => {
    try {
      await copyTextToClipboard(code);
      setDeviceCodeCopied(true);
    } catch {
      // error-policy:J4 Clipboard denial is represented by the unchanged copy affordance.
      setDeviceCodeCopied(false);
    }
  }, []);

  useEffect(() => {
    if (!deviceCode) return;
    setDeviceCodeCopied(false);
    void copyDeviceCode(deviceCode);
  }, [copyDeviceCode, deviceCode]);

  useEffect(() => {
    return () => {
      closeEventSource();
    };
  }, [closeEventSource]);

  const subscribeToFlow = useCallback(
    (newSessionId: string) => {
      if (!activeProviderId) return;
      closeEventSource();
      const url = `/api/accounts/${activeProviderId}/oauth/status?sessionId=${encodeURIComponent(newSessionId)}`;
      const source = openEventSource(url);
      eventSourceRef.current = source;
      if (!source) {
        clearSubscriptionOAuth(activeProviderId);
        setErrorMessage(
          t("accounts.add.oauth.sseUnreachable", {
            defaultValue:
              "Lost connection to the OAuth status stream. Try again.",
          }),
        );
        setStep("error");
        return;
      }

      // EventSource auto-reconnects on transient network blips, which
      // is fine. But persistent failures (server gone, route 404) just
      // toggle readyState=2 forever and the user is stuck on "Waiting
      // for browser…". Surface that after a small grace period so the
      // user can retry instead of staring at a spinner.
      let connectedOnce = false;
      let persistentErrorTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelPersistentErrorTimer = () => {
        if (persistentErrorTimer) {
          clearTimeout(persistentErrorTimer);
          persistentErrorTimer = null;
        }
      };

      source.onopen = () => {
        connectedOnce = true;
        cancelPersistentErrorTimer();
      };

      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SseFlowState;
          if (data.status === "success" && data.account) {
            cancelPersistentErrorTimer();
            closeEventSource();
            sessionIdRef.current = null;
            clearSubscriptionOAuth(activeProviderId);
            onCreated(data.account);
            onClose();
          } else if (
            data.status === "error" ||
            data.status === "cancelled" ||
            data.status === "timeout"
          ) {
            cancelPersistentErrorTimer();
            closeEventSource();
            sessionIdRef.current = null;
            clearSubscriptionOAuth(activeProviderId);
            setErrorMessage(
              data.error ??
                t(`accounts.add.oauth.${data.status}`, {
                  defaultValue:
                    data.status === "timeout"
                      ? "Login timed out. Try again."
                      : data.status === "cancelled"
                        ? "Login cancelled."
                        : "Login failed.",
                }),
            );
            setStep("error");
          }
        } catch {
          // error-policy:J3 Invalid status events cannot advance the OAuth state machine.
        }
      };

      source.onerror = () => {
        // EventSource readyState: 0=connecting, 1=open, 2=closed.
        // If we're at 2 and never got an `onopen`, the route is
        // unreachable. Give the browser ~5s to retry; if it can't
        // recover, surface the error.
        if (persistentErrorTimer) return;
        persistentErrorTimer = setTimeout(() => {
          persistentErrorTimer = null;
          if (
            !connectedOnce &&
            eventSourceRef.current?.readyState === EventSource.CLOSED
          ) {
            closeEventSource();
            sessionIdRef.current = null;
            setErrorMessage(
              t("accounts.add.oauth.sseUnreachable", {
                defaultValue:
                  "Lost connection to the OAuth status stream. Try again.",
              }),
            );
            setStep("error");
          }
        }, 5_000);
      };
    },
    [closeEventSource, onClose, onCreated, activeProviderId, t],
  );

  useEffect(() => {
    if (!open || !activeProviderId) return;
    const pending = readSubscriptionOAuth(activeProviderId);
    if (!pending || restoredSessionRef.current === pending.sessionId) return;
    restoredSessionRef.current = pending.sessionId;
    sessionIdRef.current = pending.sessionId;
    setSessionId(pending.sessionId);
    setDeviceCode(pending.deviceCode ?? null);
    setOauthUrl(pending.oauthUrl ?? null);
    setStep(
      pending.phase === "need-code" ? "oauth-need-code" : "oauth-waiting",
    );
    subscribeToFlow(pending.sessionId);
  }, [open, activeProviderId, subscribeToFlow]);

  const startOAuth = useCallback(
    async (mode: "localhost" | "device") => {
      if (!activeProviderId) {
        setStep("provider-select");
        return;
      }
      if (subscriptionAddMode !== "oauth") {
        setStep("unavailable");
        return;
      }
      setErrorMessage(null);
      setStep("oauth-starting");

      // Auto-open a real browser window ONLY for the Codex localhost-callback
      // flow, where the :1455 listener catches the redirect and completes login
      // hands-free. Every other flow — Codex device code, and Anthropic's
      // console-callback paste — shows a copyable link instead of hijacking a
      // tab, so the user signs in wherever they want and enters/pastes the code.
      // (preOpenWindow must run synchronously in the click gesture.)
      const opensWindow =
        mode === "localhost" && activeProviderId === "openai-codex";
      const win = opensWindow ? preOpenWindow() : null;
      try {
        const flow = await client.startAccountOAuth(activeProviderId, {
          label: label.trim(),
          mode,
          ...(credentialRepairAccount
            ? { replaceAccountId: credentialRepairAccount.id }
            : {}),
        });
        sessionIdRef.current = flow.sessionId;
        restoredSessionRef.current = flow.sessionId;
        setSessionId(flow.sessionId);
        setDeviceCode(flow.userCode ?? null);
        // Show the sign-in link for every non-auto-open flow.
        setOauthUrl(opensWindow ? null : (flow.authUrl ?? null));
        writeSubscriptionOAuth({
          providerId: activeProviderId,
          sessionId: flow.sessionId,
          mode,
          phase: flow.needsCodeSubmission ? "need-code" : "waiting",
          ...(flow.userCode ? { deviceCode: flow.userCode } : {}),
          ...(!opensWindow && flow.authUrl ? { oauthUrl: flow.authUrl } : {}),
          startedAt: Date.now(),
        });
        if (flow.needsCodeSubmission) {
          setStep("oauth-need-code");
        } else {
          setStep("oauth-waiting");
        }
        subscribeToFlow(flow.sessionId);
        if (opensWindow) {
          navigatePreOpenedWindow(win, flow.authUrl);
        }
      } catch (err) {
        // error-policy:J4 Enrollment failures remain visible and retryable in the dialog.
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : t("accounts.add.oauth.startFailed", {
                defaultValue: "Failed to start login flow.",
              }),
        );
        setStep("error");
        try {
          win?.close();
        } catch {
          // error-policy:J6 A cross-origin popup closes with its own browsing context.
        }
      }
    },
    [
      label,
      activeProviderId,
      credentialRepairAccount,
      subscribeToFlow,
      subscriptionAddMode,
      t,
    ],
  );

  const submitOAuthCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!activeProviderId) return;
      const code = oauthCode.trim();
      const id = sessionIdRef.current;
      if (!code || !id) return;
      try {
        await client.submitAccountOAuthCode(activeProviderId, {
          sessionId: id,
          code,
        });
        const pending = readSubscriptionOAuth(activeProviderId);
        if (pending?.sessionId === id) {
          writeSubscriptionOAuth({ ...pending, phase: "waiting" });
        }
        setOauthCode("");
        setStep("oauth-waiting");
      } catch (err) {
        // error-policy:J4 Code rejection remains visible and retryable in the dialog.
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : t("accounts.add.oauth.codeFailed", {
                defaultValue: "Failed to submit code.",
              }),
        );
        setStep("error");
      }
    },
    [oauthCode, activeProviderId, t],
  );

  const submitApiKey = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!activeProviderId) return;
      const trimmedLabel = label.trim();
      const trimmedKey = apiKey.trim();
      if (!trimmedLabel || !trimmedKey) return;
      setErrorMessage(null);
      setStep("apikey-submitting");
      try {
        const account = await client.createApiKeyAccount(activeProviderId, {
          label: trimmedLabel,
          apiKey: trimmedKey,
          ...(credentialRepairAccount
            ? { replaceAccountId: credentialRepairAccount.id }
            : {}),
        });
        onCreated(account);
        onClose();
      } catch (err) {
        // error-policy:J4 Credential rejection remains visible and retryable in the dialog.
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : t("accounts.add.apikey.failed", {
                defaultValue: "Failed to add account.",
              }),
        );
        setStep("error");
      }
    },
    [
      apiKey,
      label,
      onClose,
      onCreated,
      activeProviderId,
      credentialRepairAccount,
      t,
    ],
  );

  const handleClose = useCallback(() => {
    if (activeProviderId) clearSubscriptionOAuth(activeProviderId);
    void cancelInflightFlow();
    reset();
    onClose();
  }, [cancelInflightFlow, onClose, activeProviderId, reset]);

  const chooseProvider = useCallback(
    (nextProviderId: LinkedAccountProviderId) => {
      setSelectedProviderId(nextProviderId);
      setLabel(defaultOAuthLabel(nextProviderId));
      setApiKey("");
      setOauthCode("");
      setErrorMessage(null);
      setSessionId(null);
      setDeviceCode(null);
      setOauthUrl(null);
      setStep(initialStepForProvider(nextProviderId));
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedProviderId(providerId ?? null);
    // An in-flight persisted OAuth session (user is mid-login, e.g. on the
    // paste-code screen) is restored by the effect above. Resetting the step
    // here would stomp that restore back to the provider's first screen
    // whenever the surface remounts (tab switch, HMR), losing the user's
    // place. Let the restore effect own step/label while a session persists.
    if (providerId && readSubscriptionOAuth(providerId)) return;
    setStep(
      providerId ? initialStepForProvider(providerId) : "provider-select",
    );
    setLabel(
      credentialRepairAccount?.id
        ? credentialRepairAccount.label
        : providerId
          ? defaultOAuthLabel(providerId)
          : "",
    );
    setApiKey("");
    setOauthCode("");
    setErrorMessage(null);
    setSessionId(null);
    setDeviceCode(null);
    setDeviceCodeCopied(false);
    setOauthUrl(null);
  }, [
    open,
    providerId,
    credentialRepairAccount?.id,
    credentialRepairAccount?.label,
  ]);

  const dialogDescription = credentialRepairAccount
    ? credentialRepairAccount.source === "oauth"
      ? t("accounts.reauthenticate.description", {
          defaultValue:
            "Sign in again with the same provider. Your current credential stays active until the new sign-in succeeds, then this account is updated in place.",
        })
      : t("accounts.replaceCredential.description", {
          defaultValue:
            "Enter a new credential for the same provider. The current credential stays unchanged until the replacement is verified and saved.",
        })
    : !activeProviderId
      ? t("accounts.add.chooseDescription", {
          defaultValue:
            "Choose the provider you want to connect. Chat providers use API keys; coding subscriptions use first-party login or dedicated plan credentials.",
        })
      : subscriptionAddMode === "oauth"
        ? t("accounts.add.subscriptionDescription", {
            defaultValue:
              "Sign in with the provider's first-party coding account flow to add another account to the rotation pool.",
          })
        : subscriptionAddMode === "api-key"
          ? t("accounts.add.codingPlanDescription", {
              defaultValue:
                "Paste a coding-plan credential for the provider's dedicated coding endpoint. It will not be used as a general API key.",
            })
          : subscriptionAddMode === "external-cli"
            ? t("accounts.add.externalCliDescription", {
                defaultValue:
                  "This subscription is managed by the provider's CLI. The app does not import or replay CLI tokens.",
              })
            : subscriptionAddMode === "unavailable"
              ? t("accounts.add.unavailableDescription", {
                  defaultValue:
                    "This provider does not expose a safe first-party coding subscription surface for linking here.",
                })
              : t("accounts.add.apiDescription", {
                  defaultValue:
                    "Paste your API key. The key is stored locally with mode 0600.",
                });

  const apiKeyLabel =
    subscriptionAddMode === "api-key"
      ? t("accounts.add.codingPlanKey", {
          defaultValue: "Coding-plan key",
        })
      : t("accounts.add.apiKey", { defaultValue: "API key" });

  const apiKeyPlaceholder =
    activeProviderId === "zai-coding"
      ? "zai-..."
      : activeProviderId === "kimi-coding"
        ? "sk-..."
        : "sk-...";

  const unavailableCopy =
    activeProviderId === "gemini-cli"
      ? t("accounts.add.geminiCliHint", {
          defaultValue:
            "Run gemini auth login in your terminal. Task agents will use the authenticated Gemini CLI directly; no Gemini subscription token is copied into API settings.",
        })
      : activeProviderId === "deepseek-coding"
        ? t("accounts.add.deepseekUnavailableHint", {
            defaultValue:
              "DeepSeek is unavailable here because there is no first-party coding subscription endpoint to integrate safely. Use the DeepSeek API-key provider only if you have direct API billing.",
          })
        : t("accounts.add.providerUnavailableHint", {
            defaultValue:
              "This provider cannot be linked through this dialog right now.",
          });

  const labelInput = (
    <div className="grid gap-1.5">
      <Label htmlFor="add-account-label">
        {t("accounts.add.label", { defaultValue: "Account name" })}
      </Label>
      <Input
        id="add-account-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t("accounts.add.labelPlaceholder", {
          defaultValue: "e.g. Personal, Work",
        })}
        maxLength={120}
        autoFocus
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Opening an external OAuth page can produce a transient dismiss from
        // the dialog primitive as focus leaves this window. During a flow that
        // is not a user cancellation: keep the controlled dialog and its code
        // entry state alive. The visible Cancel button remains the one explicit
        // operation that clears persisted state and cancels the server flow.
        if (
          !next &&
          step !== "oauth-starting" &&
          step !== "oauth-waiting" &&
          step !== "oauth-need-code"
        ) {
          handleClose();
        }
      }}
    >
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {activeProviderId
              ? credentialRepairAccount
                ? credentialRepairAccount.source === "oauth"
                  ? t("accounts.reauthenticate.title", {
                      defaultValue: `Reauthenticate ${credentialRepairAccount.label}`,
                      account: credentialRepairAccount.label,
                    })
                  : t("accounts.replaceCredential.title", {
                      defaultValue: `Replace credential for ${credentialRepairAccount.label}`,
                      account: credentialRepairAccount.label,
                    })
                : t("accounts.add.title", {
                    defaultValue: `Add ${providerDisplayName(activeProviderId, t)} account`,
                    provider: providerDisplayName(activeProviderId, t),
                  })
              : t("accounts.add.chooseTitle", {
                  defaultValue: "Add a provider account",
                })}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {step === "provider-select" ? (
          <ProviderPicker onPick={chooseProvider} />
        ) : null}

        {step === "choose" ? (
          <div className="grid gap-3 py-2">
            <p className="text-xs text-muted">
              {credentialRepairAccount
                ? `${credentialRepairAccount.label} keeps its name, priority, and position in the account pool.`
                : "The connected account's email address will be used as its name."}
            </p>
            <Button
              type="button"
              variant="default"
              onClick={() =>
                void startOAuth(
                  subscriptionOAuthModeForHostname(window.location.hostname),
                )
              }
              className="h-10"
            >
              {activeProviderId === "openai-codex"
                ? subscriptionOAuthModeForHostname(window.location.hostname) ===
                  "localhost"
                  ? "Log in with localhost callback"
                  : "Log in with device code"
                : "Log in and paste a code"}
            </Button>
            {/*
              Manual device-code override. The primary button auto-picks by
              hostname, but that heuristic can't tell a real localhost from a
              TUNNELED localhost (SSH -L / port-forward): the browser is remote
              yet the URL is `localhost`, so the loopback :1455 callback lands on
              the wrong machine. This override lets Codex users force the device
              flow (visit auth.openai.com/codex/device + enter a code) without
              needing to reach the app on a non-localhost address.
            */}
            {activeProviderId === "openai-codex" &&
            subscriptionOAuthModeForHostname(window.location.hostname) ===
              "localhost" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void startOAuth("device")}
                className="h-8 text-xs text-muted hover:text-txt"
              >
                Use a device code instead (for SSH tunnels / another browser)
              </Button>
            ) : null}
            {/* API-key path is intentionally hidden for subscription providers. */}
          </div>
        ) : null}

        {step === "oauth-starting" ? (
          <div className="flex items-center gap-3 py-6 text-sm text-muted">
            <Spinner className="h-4 w-4" />
            {t("accounts.add.oauth.starting", {
              defaultValue: "Starting login flow…",
            })}
          </div>
        ) : null}

        {step === "oauth-waiting" ? (
          <div className="grid gap-3 py-3 text-sm text-muted">
            {deviceCode ? (
              // Device flow: show the verification URL + code as instructions.
              // We deliberately do NOT auto-open a browser — the user opens the
              // link wherever they want (a second device, another browser).
              <div className="grid gap-3">
                <div className="grid gap-1">
                  <p className="text-xs text-txt">
                    1. Open this link in your browser and sign in
                  </p>
                  <a
                    href={oauthUrl ?? "https://auth.openai.com/codex/device"}
                    target="_blank"
                    rel="noreferrer"
                    className="select-all break-all text-xs font-medium text-txt underline underline-offset-2 hover:text-muted"
                  >
                    {oauthUrl ?? "https://auth.openai.com/codex/device"}
                  </a>
                </div>
                <div className="grid gap-1">
                  <p className="text-xs text-txt">
                    2. Enter this one-time code after you sign in (expires in
                    ~15 minutes)
                  </p>
                  <div className="rounded border border-border bg-card p-3 text-center">
                    <code className="select-all text-lg font-semibold tracking-widest text-txt">
                      {deviceCode}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mx-auto mt-2 h-7 text-xs"
                      onClick={() => void copyDeviceCode(deviceCode)}
                    >
                      {deviceCodeCopied ? "Copied to clipboard" : "Copy code"}
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Spinner className="h-3.5 w-3.5" />
                  <span>Waiting for you to approve in your browser…</span>
                </div>
              </div>
            ) : (
              // Localhost callback flow: a real browser window was opened.
              <div className="flex items-center gap-3">
                <Spinner className="h-4 w-4" />
                <span>
                  {t("accounts.add.oauth.waiting", {
                    defaultValue:
                      "Waiting for browser… Complete the sign-in there.",
                  })}
                </span>
              </div>
            )}
            {sessionId ? (
              <p className="text-xs text-muted">
                {t("accounts.add.oauth.sessionHint", {
                  defaultValue: "Session: {{sessionId}}",
                  sessionId: `${sessionId.slice(0, 8)}…`,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "oauth-need-code" ? (
          <form onSubmit={submitOAuthCode} className="grid gap-3 py-2">
            {/* Show the sign-in link to open manually (not auto-opened) so the
                user can sign in from any browser / a second device, then paste
                the code back here. */}
            {oauthUrl ? (
              <div className="grid gap-1">
                <p className="text-xs text-txt">
                  1. Open this link and sign in
                </p>
                <a
                  href={oauthUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="select-all break-all text-xs font-medium text-txt underline underline-offset-2 hover:text-muted"
                >
                  {oauthUrl}
                </a>
                <p className="mt-1 text-xs text-txt">
                  2. Paste the code (or full redirect URL) it gives you
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted">
                {t("accounts.add.oauth.codeHint", {
                  defaultValue:
                    "Paste the code (or full redirect URL) from the browser.",
                })}
              </p>
            )}
            <Input
              value={oauthCode}
              onChange={(e) => setOauthCode(e.target.value)}
              placeholder={t("accounts.add.oauth.codePlaceholder", {
                defaultValue: "Paste the code or redirect URL",
              })}
              autoFocus
            />
            <Button
              type="submit"
              variant="default"
              disabled={!oauthCode.trim()}
              className="h-9"
            >
              {t("accounts.add.oauth.submitCode", {
                defaultValue: "Submit code",
              })}
            </Button>
          </form>
        ) : null}

        {step === "apikey" || step === "apikey-submitting" ? (
          <form onSubmit={submitApiKey} className="grid gap-3 py-2">
            {credentialRepairAccount ? (
              <div className="rounded-sm border border-border/50 bg-bg-accent/50 px-3 py-2 text-xs text-muted">
                Replacing the credential for {credentialRepairAccount.label}.
                The account name and pool position will not change.
              </div>
            ) : (
              labelInput
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="add-account-apikey">{apiKeyLabel}</Label>
              <Input
                id="add-account-apikey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button
              type="submit"
              variant="default"
              disabled={
                step === "apikey-submitting" || !label.trim() || !apiKey.trim()
              }
              className="h-9"
            >
              {step === "apikey-submitting" ? (
                <Spinner className="h-3 w-3" />
              ) : credentialRepairAccount ? (
                t("accounts.replaceCredential.save", {
                  defaultValue: "Save replacement",
                })
              ) : (
                t("accounts.add.save", { defaultValue: "Add account" })
              )}
            </Button>
          </form>
        ) : null}

        {step === "unavailable" ? (
          <div className="rounded-sm border border-border/50 bg-bg-accent/50 px-3 py-2 text-sm text-muted">
            {unavailableCopy}
          </div>
        ) : null}

        {step === "error" && errorMessage ? (
          <div
            className={cn(
              "rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive",
            )}
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          {step === "error" ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setErrorMessage(null);
                setStep(
                  activeProviderId
                    ? initialStepForProvider(activeProviderId)
                    : "provider-select",
                );
              }}
            >
              {t("accounts.add.tryAgain", { defaultValue: "Try again" })}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={handleClose}>
            {t("accounts.cancel", { defaultValue: "Cancel" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
