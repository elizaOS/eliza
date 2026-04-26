/**
 * LoginView — multi-method login for Milady.
 *
 * Four tabs, rendered in this order (password first: most common for local installs):
 *   1. Password   — displayName + password + remember device + submit
 *   2. Eliza Cloud SSO — single button (disabled with tooltip until P2 backend lands)
 *   3. Connector  — sign in via Discord / Telegram DM link (disabled until P3)
 *   4. Pairing code — legacy 4-4-4 pairing flow; kept through the 14-day grace window
 *
 * On a 200 from /api/auth/me the caller should redirect to "/".
 *
 * Uses @elizaos/ui primitives (Tabs, Card, Input, Label, Button) + onboarding
 * styles for the dark visual shell.
 */

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/ui";
import { useCallback, useId, useState } from "react";
import { type AuthLoginResult, authLoginPassword } from "../../api/auth-client";
import {
  OnboardingStepDivider,
  onboardingBodyTextShadowStyle,
  onboardingDescriptionClass,
  onboardingEyebrowClass,
  onboardingTitleClass,
} from "../onboarding/onboarding-step-chrome";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginViewProps {
  /**
   * Called after a successful login so the shell can redirect to the
   * main dashboard.
   */
  onLoginSuccess: () => void;
  /**
   * Whether Eliza Cloud SSO is available. When false the SSO tab button is
   * disabled with an explanatory tooltip.
   */
  cloudEnabled?: boolean;
  /**
   * Connector bindings available for DM-link login.
   * Empty array → connector tab shows "no bindings" state.
   */
  connectorBindings?: ConnectorBinding[];
  /** Optional legacy pairing props forwarded to the pairing tab. */
  pairing?: PairingTabProps;
  /** Injected login function (tests). */
  loginFn?: (params: {
    displayName: string;
    password: string;
    rememberDevice?: boolean;
  }) => Promise<AuthLoginResult>;
  reason?: "remote_auth_required" | "remote_password_not_configured";
}

export interface ConnectorBinding {
  connector: "discord" | "telegram" | "wechat" | "matrix";
  displayHandle: string;
}

export interface PairingTabProps {
  pairingEnabled: boolean;
  pairingCodeInput: string;
  pairingBusy: boolean;
  pairingError: string | null;
  onCodeChange: (value: string) => void;
  onSubmit: (code: string) => void;
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
  const displayNameId = useId().replace(/:/g, "");
  const passwordId = useId().replace(/:/g, "");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [submitState, setSubmitState] = useState<PasswordSubmitState>({
    phase: "idle",
  });

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
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
            err instanceof Error ? err.message : "Network error — try again.",
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
    [displayName, password, rememberDevice, loginFn, onLoginSuccess],
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
            Display name
          </Label>
          <Input
            id={displayNameId}
            type="text"
            autoComplete="username"
            placeholder="Your display name"
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
            Password
          </Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
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
            className="h-4 w-4 rounded border-border accent-primary"
          />
          Remember this device for 30 days
        </label>
      </div>

      {submitState.phase === "error" && (
        <p
          role="alert"
          className="rounded-lg border border-[color:color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color:color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-3 text-sm text-danger"
        >
          {submitState.message}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || !displayName.trim() || !password}
        className="w-full"
      >
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

// ── SSO tab ───────────────────────────────────────────────────────────────────

function SsoTab({ cloudEnabled }: { cloudEnabled: boolean }) {
  const tooltipText =
    "Available when Eliza Cloud is configured on this instance.";

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <p className="text-sm text-muted-foreground text-center leading-relaxed">
        Sign in with your Eliza Cloud account. This method requires the instance
        to have an active Eliza Cloud connection.
      </p>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-full">
              <Button
                asChild={cloudEnabled}
                disabled={!cloudEnabled}
                className="w-full"
                variant="outline"
              >
                {cloudEnabled ? (
                  <a href="/api/auth/login/sso/start?returnTo=/">
                    Sign in with Eliza Cloud
                  </a>
                ) : (
                  <span>Sign in with Eliza Cloud</span>
                )}
              </Button>
            </span>
          </TooltipTrigger>
          {!cloudEnabled && <TooltipContent>{tooltipText}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

// ── Connector tab ─────────────────────────────────────────────────────────────

function ConnectorTab({ bindings }: { bindings: ConnectorBinding[] }) {
  const hasBindings = bindings.length > 0;
  const unavailableTooltip =
    "Available when a connector owner is bound to this instance.";

  if (!hasBindings) {
    return (
      <div className="flex flex-col items-center gap-4 py-2">
        <p className="text-sm text-muted-foreground text-center leading-relaxed">
          Log in via a Discord or Telegram message. This method requires a
          connector owner binding to be configured first.
        </p>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="w-full">
                <Button disabled className="w-full" variant="outline">
                  Send login link
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{unavailableTooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <p className="text-xs text-muted-foreground/60 text-center">
          No connector bindings configured. Set up a connector in Settings to
          enable this method.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Choose a connector — we&rsquo;ll send you a one-time login link.
      </p>
      <div className="flex flex-col gap-2">
        {bindings.map((b) => (
          <ConnectorLoginButton
            key={`${b.connector}:${b.displayHandle}`}
            binding={b}
          />
        ))}
      </div>
    </div>
  );
}

type ConnectorSendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; connector: string }
  | { phase: "error"; message: string };

function ConnectorLoginButton({ binding }: { binding: ConnectorBinding }) {
  const [state, setState] = useState<ConnectorSendState>({ phase: "idle" });

  const handleClick = useCallback(async () => {
    setState({ phase: "sending" });
    try {
      // P3 backend route — may not exist yet. Surface 404 gracefully.
      const res = await fetch("/api/auth/login/owner/dm-link/request", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connector: binding.connector,
          externalId: binding.displayHandle,
        }),
      });
      if (res.status === 404) {
        setState({
          phase: "error",
          message: "DM-link login is not yet available (backend pending).",
        });
        return;
      }
      if (!res.ok) {
        setState({
          phase: "error",
          message: `Request failed (${res.status}). Try again.`,
        });
        return;
      }
      setState({ phase: "sent", connector: binding.connector });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }, [binding]);

  const label = `${binding.connector[0].toUpperCase()}${binding.connector.slice(1)} — ${binding.displayHandle}`;

  if (state.phase === "sent") {
    return (
      <p className="rounded-lg border border-[var(--ok-muted)] bg-[var(--ok-subtle)] px-4 py-3 text-sm text-ok">
        Login link sent via {state.connector}. Click it to sign in.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        disabled={state.phase === "sending"}
        onClick={handleClick}
        className="w-full justify-start"
      >
        {state.phase === "sending" ? "Sending…" : `Send link via ${label}`}
      </Button>
      {state.phase === "error" && (
        <p className="text-xs text-danger">{state.message}</p>
      )}
    </div>
  );
}

// ── Pairing tab ───────────────────────────────────────────────────────────────

function PairingTab({ pairing }: { pairing: PairingTabProps | undefined }) {
  const pairingCodeId = useId().replace(/:/g, "");

  if (!pairing) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Pairing is not available in the current server configuration.
      </p>
    );
  }

  const code = pairing.pairingCodeInput.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code) pairing.onSubmit(code);
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground leading-relaxed">
        Enter the pairing code shown in your CLI or desktop app. This method
        will be removed after the 14-day migration grace window.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={pairingCodeId}
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Pairing code
        </Label>
        <Input
          id={pairingCodeId}
          type="text"
          placeholder="xxxx-xxxx-xxxx"
          value={pairing.pairingCodeInput}
          onChange={(e) => pairing.onCodeChange(e.target.value)}
          disabled={pairing.pairingBusy || !pairing.pairingEnabled}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {pairing.pairingError && (
        <p role="alert" className="text-sm text-danger">
          {pairing.pairingError}
        </p>
      )}
      <Button
        type="submit"
        disabled={pairing.pairingBusy || !pairing.pairingEnabled || !code}
        className="w-full"
      >
        {pairing.pairingBusy ? "Pairing…" : "Submit code"}
      </Button>
    </form>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg px-4 py-6 font-body text-txt sm:px-6";
const SCREEN_CARD_CLASS =
  "relative z-10 w-full max-w-[520px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.35)] backdrop-blur-xl";

export function LoginView({
  onLoginSuccess,
  cloudEnabled = false,
  connectorBindings = [],
  pairing,
  loginFn,
  reason,
}: LoginViewProps) {
  const remotePasswordMissing = reason === "remote_password_not_configured";
  return (
    <div className={SCREEN_SHELL_CLASS}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_40%),linear-gradient(180deg,rgba(11,14,20,0.24),rgba(6,7,8,0.62))]" />
        <div className="absolute left-[-8%] top-[10%] h-[20rem] w-[20rem] rounded-full bg-[rgba(240,185,11,0.09)] blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-6%] h-[18rem] w-[18rem] rounded-full bg-[rgba(255,255,255,0.06)] blur-[110px]" />
      </div>

      <Card className={SCREEN_CARD_CLASS}>
        <CardHeader className="pb-2 pt-6 px-6">
          <div className="mb-1">
            <p
              className={onboardingEyebrowClass}
              style={onboardingBodyTextShadowStyle}
            >
              Milady
            </p>
            <OnboardingStepDivider />
            <CardTitle
              className={cn(onboardingTitleClass, "mt-2")}
              style={{ textShadow: "var(--onboarding-text-shadow-strong)" }}
            >
              Sign in
            </CardTitle>
            <p
              className={cn(onboardingDescriptionClass, "mt-2")}
              style={onboardingBodyTextShadowStyle}
            >
              {remotePasswordMissing
                ? "Remote access is not enabled yet. Open this instance on the host machine via localhost and set a remote password in Settings."
                : "Choose your login method below."}
            </p>
          </div>
        </CardHeader>

        <CardContent className="px-6 pb-6">
          <Tabs defaultValue="password">
            <TabsList className="mb-5 w-full grid grid-cols-4">
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="sso">Cloud</TabsTrigger>
              <TabsTrigger value="connector">Connector</TabsTrigger>
              <TabsTrigger value="pairing">Pairing</TabsTrigger>
            </TabsList>

            <TabsContent value="password">
              {remotePasswordMissing ? (
                <p className="rounded-lg border border-border/60 bg-bg/50 px-4 py-3 text-sm leading-6 text-muted-foreground">
                  Remote password login has not been configured. Open this
                  instance on the host machine with localhost, then set a remote
                  password in Settings.
                </p>
              ) : (
                <PasswordTab
                  onLoginSuccess={onLoginSuccess}
                  loginFn={loginFn}
                />
              )}
            </TabsContent>

            <TabsContent value="sso">
              <SsoTab cloudEnabled={cloudEnabled} />
            </TabsContent>

            <TabsContent value="connector">
              <ConnectorTab bindings={connectorBindings} />
            </TabsContent>

            <TabsContent value="pairing">
              <PairingTab pairing={pairing} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
