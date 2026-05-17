/**
 * AddAccountDialog — modal that walks the user through adding a new
 * credential to a provider's account pool.
 *
 * Paths:
 *   - **OAuth** (subscription providers): start the server-side OAuth
 *     flow, open the auth URL in a real browser window via
 *     `preOpenWindow` + `navigatePreOpenedWindow` (preserves the user
 *     gesture so popup blockers don't fire), then subscribe to the
 *     SSE stream at `/api/accounts/:provider/oauth/status` for terminal
 *     state. On `success`, hand the new `LinkedAccountConfig` to the
 *     parent. On error / timeout / cancel, surface the message inline
 *     and let the user retry. If the dialog closes mid-flow we cancel
 *     the server-side listener so it doesn't leak.
 *   - **Coding-plan key**: simple label + key form for dedicated coding
 *     endpoints only. These credentials are not written to general API env vars.
 *   - **External CLI**: show the first-party CLI login instruction; no token import.
 *   - **Unavailable**: explain why the provider cannot be linked safely.
 *   - **API key**: simple label + key form, immediate POST.
 *
 * The dialog is provider-aware: subscription providers are intentionally
 * constrained to their first-party coding surfaces.
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
import { useApp } from "../../state";
import { navigatePreOpenedWindow, preOpenWindow } from "../../utils";
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

interface AddAccountDialogProps {
  open: boolean;
  providerId: LinkedAccountProviderId;
  onClose: () => void;
  onCreated: (account: LinkedAccountConfig) => void;
}

type DialogStep =
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
    default:
      return providerId;
  }
}

export function AddAccountDialog({
  open,
  providerId,
  onClose,
  onCreated,
}: AddAccountDialogProps) {
  const { t } = useApp();
  const subscriptionAddMode = getSubscriptionAddMode(providerId);

  const [step, setStep] = useState<DialogStep>(
    initialStepForProvider(providerId),
  );
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Mirrors the `open` prop in a ref so async paths (`startOAuth` mid-
  // await) can detect that the dialog was closed before
  // `client.startAccountOAuth` resolved and immediately cancel the
  // freshly-created server-side flow.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cancelInflightFlow = useCallback(async () => {
    closeEventSource();
    const id = sessionIdRef.current;
    if (id) {
      sessionIdRef.current = null;
      try {
        await client.cancelAccountOAuth(providerId, { sessionId: id });
      } catch {
        // Best-effort cleanup — server times out flows on its own.
      }
    }
  }, [closeEventSource, providerId]);

  const reset = useCallback(() => {
    closeEventSource();
    sessionIdRef.current = null;
    setStep(initialStepForProvider(providerId));
    setLabel("");
    setApiKey("");
    setOauthCode("");
    setErrorMessage(null);
    setSessionId(null);
  }, [closeEventSource, providerId]);

  // Dialog open/close side-effects: when closed, cancel any in-flight
  // OAuth flow so the server can release the loopback listener.
  useEffect(() => {
    if (!open) {
      void cancelInflightFlow();
      reset();
    }
  }, [open, cancelInflightFlow, reset]);

  useEffect(() => {
    return () => {
      closeEventSource();
    };
  }, [closeEventSource]);

  const subscribeToFlow = useCallback(
    (newSessionId: string) => {
      closeEventSource();
      const url = `/api/accounts/${providerId}/oauth/status?sessionId=${encodeURIComponent(newSessionId)}`;
      const source = new EventSource(url);
      eventSourceRef.current = source;

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
          // Malformed SSE event — ignore; the next valid one will progress.
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
    [closeEventSource, onClose, onCreated, providerId, t],
  );

  const startOAuth = useCallback(async () => {
    if (subscriptionAddMode !== "oauth") {
      setStep("unavailable");
      return;
    }
    setErrorMessage(null);
    setStep("oauth-starting");

    // Open the popup BEFORE the await so the browser sees a synchronous
    // user-gesture-triggered window.open. Once we have the URL, navigate
    // it. preOpenWindow returns null on desktop (Electrobun handles
    // routing via the IPC call inside openExternalUrl).
    const win = preOpenWindow();
    try {
      const flow = await client.startAccountOAuth(providerId, {
        label: label.trim(),
      });
      // The dialog might have been closed between user clicking "Sign
      // in" and the server returning the flow handle. If so, the
      // server-side OAuth listener is orphaned — cancel it explicitly
      // so the loopback port releases immediately instead of timing
      // out in 5 minutes.
      if (!openRef.current) {
        try {
          await client.cancelAccountOAuth(providerId, {
            sessionId: flow.sessionId,
          });
        } catch {
          // Best-effort.
        }
        try {
          win?.close();
        } catch {
          // Cross-origin — ignore.
        }
        return;
      }
      navigatePreOpenedWindow(win, flow.authUrl);
      sessionIdRef.current = flow.sessionId;
      setSessionId(flow.sessionId);
      if (flow.needsCodeSubmission) {
        setStep("oauth-need-code");
      } else {
        setStep("oauth-waiting");
      }
      subscribeToFlow(flow.sessionId);
    } catch (err) {
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
        // Cross-origin — ignore.
      }
    }
  }, [label, providerId, subscribeToFlow, subscriptionAddMode, t]);

  const submitOAuthCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const code = oauthCode.trim();
      const id = sessionIdRef.current;
      if (!code || !id) return;
      try {
        await client.submitAccountOAuthCode(providerId, {
          sessionId: id,
          code,
        });
        setOauthCode("");
        setStep("oauth-waiting");
      } catch (err) {
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
    [oauthCode, providerId, t],
  );

  const submitApiKey = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedLabel = label.trim();
      const trimmedKey = apiKey.trim();
      if (!trimmedLabel || !trimmedKey) return;
      setErrorMessage(null);
      setStep("apikey-submitting");
      try {
        const account = await client.createApiKeyAccount(providerId, {
          label: trimmedLabel,
          apiKey: trimmedKey,
        });
        onCreated(account);
        onClose();
      } catch (err) {
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
    [apiKey, label, onClose, onCreated, providerId, t],
  );

  const handleClose = useCallback(() => {
    void cancelInflightFlow();
    onClose();
  }, [cancelInflightFlow, onClose]);

  const dialogDescription =
    subscriptionAddMode === "oauth"
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
    providerId === "zai-coding"
      ? "zai-..."
      : providerId === "kimi-coding"
        ? "sk-..."
        : "sk-...";

  const unavailableCopy =
    providerId === "gemini-cli"
      ? t("accounts.add.geminiCliHint", {
          defaultValue:
            "Run gemini auth login in your terminal. Task agents will use the authenticated Gemini CLI directly; no Gemini subscription token is copied into API settings.",
        })
      : providerId === "deepseek-coding"
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
        if (!next) handleClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("accounts.add.title", {
              defaultValue: `Add ${providerDisplayName(providerId, t)} account`,
              provider: providerDisplayName(providerId, t),
            })}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {step === "choose" ? (
          <div className="grid gap-3 py-2">
            {labelInput}
            <Button
              type="button"
              variant="default"
              disabled={!label.trim()}
              onClick={() => void startOAuth()}
              className="h-10"
            >
              {t("accounts.add.signIn", {
                defaultValue: `Sign in with ${providerDisplayName(providerId, t)}`,
                provider: providerDisplayName(providerId, t),
              })}
            </Button>
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
            <div className="flex items-center gap-3">
              <Spinner className="h-4 w-4" />
              <span>
                {t("accounts.add.oauth.waiting", {
                  defaultValue:
                    "Waiting for browser… Complete the sign-in there.",
                })}
              </span>
            </div>
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
            <p className="text-xs text-muted">
              {t("accounts.add.oauth.codeHint", {
                defaultValue:
                  "Auto-redirect didn't reach us. Paste the code (or full redirect URL) from the browser.",
              })}
            </p>
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
            {labelInput}
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
              ) : (
                t("accounts.add.save", { defaultValue: "Add account" })
              )}
            </Button>
          </form>
        ) : null}

        {step === "unavailable" ? (
          <div className="rounded-md border border-border/50 bg-bg-accent/50 px-3 py-2 text-sm text-muted">
            {unavailableCopy}
          </div>
        ) : null}

        {step === "error" && errorMessage ? (
          <div
            className={cn(
              "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive",
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
                setStep(initialStepForProvider(providerId));
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
