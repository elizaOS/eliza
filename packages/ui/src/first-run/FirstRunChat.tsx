/**
 * In-chat first-run flow (#9952).
 *
 * The FIRST surface a fresh user (`firstRunComplete=false`) sees is the agent,
 * not a full-screen setup wizard: a seeded chat transcript where Eliza greets
 * the user and asks how it should run. Login, runtime choice, and the inference
 * provider choice are all rendered as the SAME in-chat widgets the live chat
 * surface uses — {@link ChoiceWidget} for the option rows and
 * {@link CredentialRequestWidget} (`oauth-link`) for the Eliza Cloud sign-in —
 * so first-run reads as one conversation instead of a separate wizard.
 *
 * This component is the DISPLAY layer only. Every runtime/provisioning/OAuth
 * decision lives in {@link useFirstRunController} (the first-run use case): the
 * widgets call `updateDraft` / `finishRuntime` / the picker callbacks, and the
 * controller owns the math, the cloud handoff, and the single
 * `POST /api/first-run`. The role-correct default provider per runtime is
 * computed once in `defaultProviderForRuntime` (first-run-config), never here.
 */

import * as React from "react";
import { ElizaMark } from "../components/brand/eliza-mark";
import { ChoiceWidget } from "../components/chat/widgets/ChoiceWidget";
import { CredentialRequestWidget } from "../components/chat/widgets/credential-request-widget";
import { getBootConfig } from "../config/boot-config-store";
import { TRAY_ACTION_EVENT } from "../events";
import { useAppSelectorShallow } from "../state";
import { AgentPicker } from "./AgentPicker";
import { defaultProviderForRuntime } from "./first-run-config";
import { trayActionToOnboardingChoice } from "./onboarding-intent";
import { useFirstRunController } from "./use-first-run-controller";

/** One assistant turn in the seeded transcript. */
function AgentBubble({
  children,
  BrandMark,
}: {
  children: React.ReactNode;
  BrandMark: React.ComponentType<{ className?: string }>;
}): React.ReactElement {
  return (
    <div className="flex w-full items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.12]">
        <BrandMark className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-[15px] leading-snug">
        {children}
      </div>
    </div>
  );
}

export function FirstRunChat(): React.ReactElement {
  const c = useFirstRunController();
  const {
    step,
    cloudOnly,
    submitting,
    busyText,
    error,
    cloudError,
    cloudLoginFallbackUrl,
    localRuntimeAvailable,
  } = c;

  const { setTab } = useAppSelectorShallow((s) => ({ setTab: s.setTab }));

  const appName = getBootConfig().branding?.appName ?? "elizaOS";
  const BrandMark = getBootConfig().brandMark ?? ElizaMark;

  // Cloud-only hosts (the hosted web bundle, the "cloud" desktop/native builds)
  // can only run on Eliza Cloud — there is no runtime or provider choice to
  // make. Hand straight off to the cloud sign-in on first paint, exactly as the
  // legacy gate did, so the in-chat flow never offers an impossible option.
  const cloudOnlyAutoStarted = React.useRef(false);
  React.useEffect(() => {
    if (cloudOnly && !cloudOnlyAutoStarted.current && step === "runtime") {
      cloudOnlyAutoStarted.current = true;
      c.updateDraft("runtime", "cloud");
      void c.finishRuntime();
    }
  }, [cloudOnly, step, c]);

  const chooseRuntime = React.useCallback(
    (value: string) => {
      if (value === "cloud") {
        c.updateDraft("runtime", "cloud");
        void c.finishRuntime();
        return;
      }
      if (value === "local") {
        // Local runtime needs the provider sub-choice before it can finish, so
        // advance to the inference step (the next agent question) rather than
        // provisioning immediately.
        c.updateDraft("runtime", "local");
        c.setStep("inference");
        return;
      }
      // "remote" — the advanced self-hosted path. Hand to the controller's
      // remote step; its remote-connect form lives in the picker region below.
      c.updateDraft("runtime", "remote");
      c.setStep("remote");
    },
    [c],
  );

  const chooseProvider = React.useCallback(
    (value: string) => {
      // `value` is one of `defaultProviderForRuntime`'s ids plus "other".
      if (value === "other") {
        // The remaining providers (Anthropic sub / Codex / z.ai / Kimi / …) are
        // configured in Settings, not in-chat. Finish on-device first so the
        // agent is usable immediately, then route to Settings via the same
        // handoff the controller's `needsProviderSetup` banner uses.
        c.updateDraft("localInference", "all-local");
        void c.finishRuntime().then(() => setTab("settings"));
        return;
      }
      c.updateDraft(
        "localInference",
        value === "elizacloud" ? "cloud-inference" : "all-local",
      );
      void c.finishRuntime();
    },
    [c, setTab],
  );

  // The macOS tray menu can drive the cloud choice (TRAY_ACTION_EVENT).
  React.useEffect(() => {
    const onTrayAction = (event: Event) => {
      const itemId =
        (event as CustomEvent<{ itemId?: string }>).detail?.itemId ?? "";
      if (trayActionToOnboardingChoice(itemId) === "cloud") {
        c.updateDraft("runtime", "cloud");
        void c.finishRuntime();
      }
    };
    document.addEventListener(TRAY_ACTION_EVENT, onTrayAction);
    return () => document.removeEventListener(TRAY_ACTION_EVENT, onTrayAction);
  }, [c]);

  // The cloud login flow surfaces its sign-in URL through cloudError as
  // "Open this link to log in: <url>" when an in-app browser open is
  // unavailable; pull it out so we render a real authorize affordance.
  const cloudLoginUrl = React.useMemo(() => {
    if (cloudLoginFallbackUrl) return cloudLoginFallbackUrl;
    const match = (cloudError ?? "").match(/https?:\/\/\S+/);
    return match ? match[0] : null;
  }, [cloudError, cloudLoginFallbackUrl]);

  const onRemote = step === "remote" && !cloudOnly;
  const onInference = step === "inference" && !cloudOnly;
  const onPickAgent = step === "pick-agent";

  // The provider question (local runtime): default pre-highlighted, never
  // auto-submitted. Default rule lives in `defaultProviderForRuntime`.
  const providerDefault = defaultProviderForRuntime("local");
  const providerOptions = [
    {
      value: "elizacloud",
      label:
        providerDefault === "elizacloud"
          ? "Eliza Cloud (recommended)"
          : "Eliza Cloud",
    },
    {
      value: "on-device",
      label:
        providerDefault === "on-device"
          ? "On-device (recommended)"
          : "On-device",
    },
  ];

  return (
    <div
      data-testid="first-run-chat"
      className="pointer-events-none fixed inset-0 overflow-y-auto p-6 text-white"
    >
      <div className="pointer-events-auto mx-auto flex w-full max-w-[30rem] flex-col gap-6 pt-[calc(var(--safe-area-top,0px)+2.5rem)] motion-safe:animate-[shell-overlay-in_220ms_ease-out]">
        <AgentBubble BrandMark={BrandMark}>
          <p data-testid="first-run-greeting">
            hey there! I'm {appName === "elizaOS" ? "Eliza" : appName}.
          </p>
        </AgentBubble>

        {/* The branches below occupy one JSX position; a step-keyed wrapper
            remounts the ChoiceWidget per question so a locked selection from a
            previous step never leaks into the next one's option row. */}
        {onPickAgent ? (
          // After cloud sign-in, when the user already has cloud agents, choose
          // one or create new. The picker is the controller's, rendered inline.
          <AgentBubble key="pick-agent" BrandMark={BrandMark}>
            <p>Which agent should I run?</p>
            <div className="text-txt">
              <AgentPicker
                agents={c.pickerAgents}
                activeAgentId={c.pickerActiveAgentId}
                phase={c.pickerPhase}
                errorMessage={c.pickerError}
                bindingAgentId={c.pickerBindingId}
                onPick={c.onPickAgent}
                onCreateNew={c.onCreateNewAgent}
                onRetry={c.onRetryPicker}
                onBack={c.onBackFromPicker}
                showBack={!cloudOnly}
              />
            </div>
          </AgentBubble>
        ) : onRemote ? (
          <AgentBubble key="remote" BrandMark={BrandMark}>
            <p>Connect your own agent — where does it live?</p>
            <RemoteConnectForm controller={c} />
          </AgentBubble>
        ) : cloudLoginUrl ? (
          // Cloud sign-in handoff rendered as the in-chat credential widget.
          <AgentBubble key="cloud-signin" BrandMark={BrandMark}>
            <p>Sign in to Eliza Cloud to continue.</p>
            <div className="text-txt">
              <CredentialRequestWidget
                variant={{
                  kind: "oauth-link",
                  provider: "Eliza Cloud",
                  authorizeUrl: cloudLoginUrl,
                  status: submitting ? "connecting" : "idle",
                }}
                onAuthorize={() => {
                  c.updateDraft("runtime", "cloud");
                  void c.finishRuntime();
                }}
              />
            </div>
          </AgentBubble>
        ) : onInference ? (
          // PROVIDER — after picking the local runtime: where should it think?
          <AgentBubble key="provider" BrandMark={BrandMark}>
            <p>Where should I run my AI?</p>
            <div className="text-txt">
              <ChoiceWidget
                id="first-run-provider"
                scope="first-run-provider"
                options={providerOptions}
                allowCustom={false}
                onChoose={chooseProvider}
              />
              <div className="mt-1">
                <ChoiceWidget
                  id="first-run-provider-other"
                  scope="first-run-provider-other"
                  options={[{ value: "other", label: "Use another provider…" }]}
                  allowCustom={false}
                  onChoose={chooseProvider}
                />
              </div>
            </div>
          </AgentBubble>
        ) : (
          // RUNTIME — the first question.
          <AgentBubble key="runtime" BrandMark={BrandMark}>
            <p>
              Do you want to log in with your Eliza Cloud account or run your
              agent locally?
            </p>
            <div className="text-txt">
              <ChoiceWidget
                id="first-run-runtime"
                scope="first-run-runtime"
                options={[
                  { value: "cloud", label: "Log in with Eliza Cloud" },
                  ...(localRuntimeAvailable
                    ? [{ value: "local", label: "Run locally on this device" }]
                    : []),
                  { value: "remote", label: "Connect my own agent" },
                ]}
                allowCustom={false}
                onChoose={chooseRuntime}
              />
            </div>
          </AgentBubble>
        )}

        {(busyText || error) && !cloudLoginUrl ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="first-run-status"
            className="pl-11 text-sm leading-snug text-white/80"
          >
            {submitting ? busyText : error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Inline remote-connect form for the advanced self-hosted path. */
function RemoteConnectForm({
  controller,
}: {
  controller: ReturnType<typeof useFirstRunController>;
}): React.ReactElement {
  const { draft, submitting } = controller;
  return (
    <div className="space-y-2 text-txt">
      <input
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={draft.remoteApiBase}
        aria-label="Server address"
        onChange={(e) =>
          controller.updateDraft("remoteApiBase", e.target.value)
        }
        placeholder="https://agent.example.com"
        data-testid="first-run-remote-address"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none"
      />
      <input
        type="password"
        value={draft.remoteToken}
        aria-label="Access token"
        onChange={(e) => controller.updateDraft("remoteToken", e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void controller.finishRuntime();
        }}
        placeholder="Access token (optional)"
        data-testid="first-run-remote-token"
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none"
      />
      <ChoiceWidget
        id="first-run-remote-actions"
        scope="first-run-remote-actions"
        options={[
          { value: "back", label: "Back" },
          { value: "connect", label: submitting ? "Connecting…" : "Connect" },
        ]}
        allowCustom={false}
        onChoose={(value) => {
          if (value === "back") {
            controller.setStep("runtime");
            return;
          }
          if (draft.remoteApiBase.trim().length > 0) {
            void controller.finishRuntime();
          }
        }}
      />
    </div>
  );
}
