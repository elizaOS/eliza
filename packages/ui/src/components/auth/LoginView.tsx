import { type FormEvent, useCallback, useId, useState } from "react";
import { type AuthLoginResult, authLoginPassword } from "../../api/auth-client";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import {
  setupBodyTextShadowStyle,
  setupDescriptionClass,
  setupEyebrowClass,
  setupTitleClass,
} from "../setup/setup-classes";
import { SetupStepDivider } from "../setup/setup-step-chrome";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginViewProps {
  /**
   * Called after a successful login so the shell can redirect to the
   * main dashboard.
   */
  onLoginSuccess: () => void;
  /** Injected login function (tests). */
  loginFn?: (params: {
    displayName: string;
    password: string;
    rememberDevice?: boolean;
  }) => Promise<AuthLoginResult>;
  reason?: "remote_auth_required" | "remote_password_not_configured";
}

// ── Password tab ──────────────────────────────────────────────────────────────

type PasswordSubmitState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "success" };

function PasswordTab({
  onLoginSuccess,
  loginFn,
}: {
  onLoginSuccess: () => void;
  loginFn?: LoginViewProps["loginFn"];
}) {
  const { t } = useTranslation();
  const displayNameId = useId().replace(/:/g, "");
  const passwordId = useId().replace(/:/g, "");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [submitState, setSubmitState] = useState<PasswordSubmitState>({
    phase: "idle",
  });

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!displayName.trim() || !password) return;
      setSubmitState({ phase: "submitting" });

      let result: AuthLoginResult;
      try {
        const fn = loginFn ?? authLoginPassword;
        result = await fn({
          displayName: displayName.trim(),
          password,
          rememberDevice,
        });
      } catch (err) {
        setSubmitState({
          phase: "error",
          message:
            err instanceof Error
              ? err.message
              : t("loginview.error.network", {
                  defaultValue: "Network error — try again.",
                }),
        });
        return;
      }

      if (result.ok === false) {
        setSubmitState({ phase: "error", message: result.message });
        return;
      }

      setSubmitState({ phase: "success" });
      onLoginSuccess();
    },
    [displayName, password, rememberDevice, loginFn, onLoginSuccess, t],
  );

  const isSubmitting = submitState.phase === "submitting";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={displayNameId}
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            {t("loginview.displayName.label", {
              defaultValue: "Display name",
            })}
          </Label>
          <Input
            id={displayNameId}
            type="text"
            autoComplete="username"
            placeholder={t("loginview.displayName.placeholder", {
              defaultValue: "Your display name",
            })}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (submitState.phase === "error")
                setSubmitState({ phase: "idle" });
            }}
            disabled={isSubmitting}
            aria-required="true"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={passwordId}
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            {t("loginview.password.label", { defaultValue: "Password" })}
          </Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            placeholder={t("loginview.password.placeholder", {
              defaultValue: "Your password",
            })}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (submitState.phase === "error")
                setSubmitState({ phase: "idle" });
            }}
            disabled={isSubmitting}
            aria-required="true"
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={rememberDevice}
            onChange={(e) => setRememberDevice(e.target.checked)}
            disabled={isSubmitting}
            className="h-4 w-4 rounded-sm border-border accent-primary"
          />
          {t("loginview.rememberDevice", {
            defaultValue: "Remember this device for 30 days",
          })}
        </label>
      </div>

      {submitState.phase === "error" && (
        <p
          role="alert"
          className="rounded-sm border border-[color:color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color:color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-3 text-sm text-danger"
        >
          {submitState.message}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || !displayName.trim() || !password}
        className="w-full"
      >
        {isSubmitting
          ? t("loginview.signingIn", { defaultValue: "Signing in…" })
          : t("loginview.signIn", { defaultValue: "Sign in" })}
      </Button>
    </form>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg px-4 py-6 font-body text-txt sm:px-6";
const SCREEN_CARD_CLASS =
  "relative z-10 w-full max-w-[520px] overflow-hidden border border-border/60 bg-card/95 backdrop-blur-xl";

export function LoginView({ onLoginSuccess, loginFn, reason }: LoginViewProps) {
  const { t } = useTranslation();
  const remotePasswordMissing = reason === "remote_password_not_configured";

  return (
    <div className={SCREEN_SHELL_CLASS}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_40%),linear-gradient(180deg,rgba(11,14,20,0.24),rgba(6,7,8,0.62))]" />
      </div>

      <Card className={SCREEN_CARD_CLASS}>
        <CardHeader className="pb-2 pt-6 px-6">
          <div className="mb-1">
            <p className={setupEyebrowClass} style={setupBodyTextShadowStyle}>
              Eliza
            </p>
            <SetupStepDivider />
            <CardTitle
              className={cn(setupTitleClass, "mt-2")}
              style={{ textShadow: "var(--first-run-text-shadow-strong)" }}
            >
              {remotePasswordMissing
                ? t("loginview.title.blocked", {
                    defaultValue: "Remote access blocked",
                  })
                : t("loginview.title.signIn", { defaultValue: "Sign in" })}
            </CardTitle>
            <p
              className={cn(setupDescriptionClass, "mt-2")}
              style={setupBodyTextShadowStyle}
            >
              {remotePasswordMissing
                ? t("loginview.description.blocked", {
                    defaultValue:
                      "A remote password is required before this instance can accept browser logins from another machine.",
                  })
                : t("loginview.description.signIn", {
                    defaultValue: "Sign in with your password.",
                  })}
            </p>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-6">
          {remotePasswordMissing ? (
            <div
              role="alert"
              className="space-y-3 rounded-sm border border-border/60 bg-bg/50 px-4 py-3 text-sm leading-6 text-muted-foreground"
            >
              <p>
                {t("loginview.blocked.body", {
                  defaultValue:
                    "The remote agent has no owner password configured yet, so it cannot accept logins from another machine. Set one on the host first.",
                })}
              </p>
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground/70">
                  {t("loginview.blocked.twoWays", {
                    defaultValue: "Two ways to fix it:",
                  })}
                </p>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground/80">
                    {t("loginview.blocked.browserHint", {
                      defaultValue:
                        "From a browser on the host machine, open this URL then go to Settings → Security:",
                    })}
                  </p>
                  <code className="block break-all rounded-sm bg-bg/70 px-2 py-1.5 font-mono text-[11px] text-foreground">
                    http://localhost:31337/
                  </code>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground/80">
                    {t("loginview.blocked.sshHint", {
                      defaultValue:
                        "Or via SSH (replace YOURNAME and YOURPASS with your own):",
                    })}
                  </p>
                  <code className="block break-all rounded-sm bg-bg/70 px-2 py-1.5 font-mono text-[11px] text-foreground">
                    {`curl -X POST http://127.0.0.1:31337/api/auth/setup -H "Content-Type: application/json" -d '{"displayName":"YOURNAME","password":"YOURPASS"}'`}
                  </code>
                </div>
              </div>
              <p className="text-xs text-muted-foreground/70">
                {t("loginview.blocked.returnHint", {
                  defaultValue:
                    "Then return to this screen — it will refresh automatically.",
                })}
              </p>
            </div>
          ) : (
            <PasswordTab onLoginSuccess={onLoginSuccess} loginFn={loginFn} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
