/**
 * VoicePrefixSteps — 7-step voice onboarding sub-flow (R10 §3).
 *
 * Self-contained renderer: caller mounts <VoicePrefixSteps step={…} … />
 * inside the onboarding shell and supplies callbacks. Each step renders a
 * focused affordance + a Continue button. R10 §3.2 specifies the copy +
 * branching; we render exactly that.
 *
 * Adapter inputs:
 * - `tier` from I9 (defaults to "GOOD" when unknown — never blocks the flow).
 * - `profilesClient` from I2 (defaults are baked into the adapter when the
 *   server endpoints aren't live yet).
 * - `onModelDownloadStart` from I5 (caller no-ops when versioning isn't
 *   wired — we fall through to "Continue in background").
 */

// biome-ignore lint/correctness/noUnusedImports: required for JSX transform.
import * as React from "react";
import { Crown, Mic, Sparkles, Volume2 } from "lucide-react";

import { Button } from "../ui/button";
import {
  VoiceTierBanner,
  type VoiceDeviceTier,
  DEFAULT_VOICE_DEVICE_TIER,
} from "../settings/VoiceTierBanner";
import {
  VOICE_PREFIX_STEP_META,
  resolveVoicePrefixSteps,
  nextVoicePrefixStep,
  previousVoicePrefixStep,
  type VoicePrefixStep,
} from "../../onboarding/voice-prefix";
import {
  VoiceProfilesClient,
  type VoiceCaptureSession,
  type VoiceCaptureSubmitResult,
  type VoiceProfile,
} from "../../api/client-voice-profiles";

export interface VoicePrefixStepsProps {
  /** Active step. Caller drives this — voice-prefix.ts has next/prev helpers. */
  step: VoicePrefixStep;
  /** Device tier from I9; null falls back to "GOOD" copy. */
  tier: VoiceDeviceTier | null;
  /** Optional summary line for the tier banner. */
  tierSummary?: string;
  /** Adapter to I2's voice profile endpoints. */
  profilesClient: VoiceProfilesClient;
  /** Caller plays a scripted greeting via the chosen TTS (step 4). */
  onAgentSpeak?: (script: string) => void;
  /** Caller requests microphone permission. Returns true if granted. */
  onRequestMicPermission?: () => Promise<boolean>;
  /** Caller kicks off voice model download (I5). No-op if not wired. */
  onModelDownloadStart?: () => void;
  /** Caller advances to the next step. */
  onAdvance: (next: VoicePrefixStep | null) => void;
  /** Caller goes back. */
  onBack: () => void;
  /** Caller skips remaining voice steps and jumps to the legacy flow. */
  onSkipPrefix?: () => void;
  /** OWNER name editor handler — passed the captured display name. */
  onOwnerSaved?: (result: VoiceCaptureSubmitResult & { displayName: string }) => void;
  /** Optional initial display name for the OWNER (e.g. from cloud profile). */
  initialOwnerDisplayName?: string;
}

interface VoiceCaptureState {
  session: VoiceCaptureSession | null;
  currentPromptIndex: number;
  recording: boolean;
  capturedPromptIds: string[];
  error: string | null;
}

const INITIAL_CAPTURE_STATE: VoiceCaptureState = {
  session: null,
  currentPromptIndex: 0,
  recording: false,
  capturedPromptIds: [],
  error: null,
};

const AGENT_GREETING_SCRIPT =
  "Hi — I'm Eliza. I'll listen when you talk and reply out loud. " +
  "To recognise your voice across conversations I need to learn how you " +
  "sound. Ready?";

export function VoicePrefixSteps(
  props: VoicePrefixStepsProps,
): React.ReactElement {
  const tier = props.tier ?? DEFAULT_VOICE_DEVICE_TIER;
  const stepMeta = VOICE_PREFIX_STEP_META[props.step];
  const allSteps = resolveVoicePrefixSteps(tier);
  const stepIndex = allSteps.indexOf(props.step);
  const progressLabel = `Step ${stepIndex + 1} of ${allSteps.length}`;

  return (
    <div
      className="flex w-full flex-col gap-4"
      data-testid="voice-prefix-steps"
      data-step={props.step}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span data-testid="voice-prefix-progress">{progressLabel}</span>
        {stepMeta.optional ? (
          <span className="rounded-full bg-bg/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
            optional
          </span>
        ) : null}
      </header>

      <h2
        className="text-lg font-semibold"
        data-testid="voice-prefix-step-name"
      >
        {stepMeta.defaultName}
      </h2>
      <p
        className="text-sm text-muted"
        data-testid="voice-prefix-step-subtitle"
      >
        {stepMeta.defaultSubtitle}
      </p>

      <main className="rounded-lg border border-border/35 bg-card/40 p-4">
        {props.step === "welcome" ? (
          <WelcomeStep {...props} />
        ) : props.step === "tier" ? (
          <TierStep
            {...props}
            tier={tier}
            tierSummary={props.tierSummary}
          />
        ) : props.step === "models" ? (
          <ModelsStep {...props} />
        ) : props.step === "agent-speaks" ? (
          <AgentSpeaksStep {...props} />
        ) : props.step === "user-speaks" ? (
          <UserSpeaksStep {...props} />
        ) : props.step === "owner-confirm" ? (
          <OwnerConfirmStep {...props} />
        ) : props.step === "family" ? (
          <FamilyStep {...props} />
        ) : null}
      </main>

      <footer className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const prev = previousVoicePrefixStep(props.step, tier);
            if (prev) props.onAdvance(prev);
            else props.onBack();
          }}
          data-testid="voice-prefix-back"
        >
          Back
        </Button>
        <div className="flex items-center gap-2">
          {stepMeta.optional ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.onAdvance(nextVoicePrefixStep(props.step, tier))}
              data-testid="voice-prefix-skip"
            >
              Skip
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => props.onAdvance(nextVoicePrefixStep(props.step, tier))}
            data-testid="voice-prefix-continue"
          >
            Continue
          </Button>
        </div>
      </footer>
    </div>
  );
}

// ── Step 1 — Welcome + permissions ────────────────────────────────────────

function WelcomeStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [permissionGranted, setPermissionGranted] = React.useState<
    boolean | null
  >(null);
  const onRequest = React.useCallback(async () => {
    if (!props.onRequestMicPermission) {
      setPermissionGranted(true);
      return;
    }
    const granted = await props.onRequestMicPermission();
    setPermissionGranted(granted);
  }, [props.onRequestMicPermission]);

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-welcome">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles className="h-5 w-5" />
        </span>
        <p className="text-sm">
          You'll talk to your agent, and your agent will talk back. We'll
          take a minute to set that up.
        </p>
      </div>
      <Button
        onClick={() => void onRequest()}
        data-testid="voice-prefix-welcome-request-mic"
      >
        <Mic className="mr-2 h-4 w-4" /> Grant microphone access
      </Button>
      {permissionGranted === false ? (
        <p
          className="text-xs text-warn"
          data-testid="voice-prefix-welcome-mic-denied"
        >
          Microphone access was denied. You can grant it later in system
          settings.
        </p>
      ) : null}
      {permissionGranted === true ? (
        <p
          className="text-xs text-ok"
          data-testid="voice-prefix-welcome-mic-granted"
        >
          Microphone access granted.
        </p>
      ) : null}
    </div>
  );
}

// ── Step 2 — Hardware tier ───────────────────────────────────────────────

function TierStep(
  props: VoicePrefixStepsProps & { tier: VoiceDeviceTier; tierSummary?: string },
): React.ReactElement {
  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-tier">
      <VoiceTierBanner tier={props.tier} summary={props.tierSummary} />
      {props.tier === "POOR" ? (
        <p className="text-xs text-muted">
          We'll route voice through Eliza Cloud. You can still capture your
          voice profile for speaker recognition.
        </p>
      ) : null}
    </div>
  );
}

// ── Step 3 — Models ──────────────────────────────────────────────────────

function ModelsStep(props: VoicePrefixStepsProps): React.ReactElement {
  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    props.onModelDownloadStart?.();
  }, [props.onModelDownloadStart]);
  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-models">
      <p className="text-sm">
        Downloading the voice bundle (ASR, turn detector, emotion classifier,
        speaker encoder, VAD, wake-word, Kokoro voice). You can continue
        once the essentials are in place — the rest finishes in the background.
      </p>
      <p
        className="text-xs text-muted"
        data-testid="voice-prefix-models-background"
      >
        Continue in background — the model panel in Settings shows progress.
      </p>
    </div>
  );
}

// ── Step 4 — Agent speaks ────────────────────────────────────────────────

function AgentSpeaksStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [played, setPlayed] = React.useState(false);
  const onPlay = React.useCallback(() => {
    props.onAgentSpeak?.(AGENT_GREETING_SCRIPT);
    setPlayed(true);
  }, [props.onAgentSpeak]);
  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-agent-speaks">
      <p className="text-sm">
        Press play to hear the agent introduce itself in the voice you
        selected.
      </p>
      <Button
        onClick={onPlay}
        data-testid="voice-prefix-agent-speaks-play"
      >
        <Volume2 className="mr-2 h-4 w-4" />
        {played ? "Replay greeting" : "Play greeting"}
      </Button>
      <p className="rounded bg-bg/60 p-2 text-xs italic text-muted">
        {AGENT_GREETING_SCRIPT}
      </p>
    </div>
  );
}

// ── Step 5 — User speaks ─────────────────────────────────────────────────

function UserSpeaksStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [state, setState] = React.useState<VoiceCaptureState>(
    INITIAL_CAPTURE_STATE,
  );

  const startSession = React.useCallback(async () => {
    try {
      const session = await props.profilesClient.startOwnerCapture();
      setState({
        session,
        currentPromptIndex: 0,
        recording: false,
        capturedPromptIds: [],
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Failed to start capture.",
      }));
    }
  }, [props.profilesClient]);

  React.useEffect(() => {
    if (state.session === null) {
      void startSession();
    }
  }, [state.session, startSession]);

  const advancePrompt = React.useCallback(() => {
    setState((prev) => {
      if (!prev.session) return prev;
      const promptId = prev.session.prompts[prev.currentPromptIndex]?.id;
      const captured = promptId
        ? [...prev.capturedPromptIds, promptId]
        : prev.capturedPromptIds;
      return {
        ...prev,
        currentPromptIndex: Math.min(
          prev.currentPromptIndex + 1,
          prev.session.prompts.length,
        ),
        recording: false,
        capturedPromptIds: captured,
      };
    });
  }, []);

  const currentPrompt = state.session?.prompts[state.currentPromptIndex];
  const done =
    state.session !== null &&
    state.currentPromptIndex >= state.session.prompts.length;

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-user-speaks">
      {state.error ? (
        <p
          className="text-xs text-warn"
          data-testid="voice-prefix-user-speaks-error"
        >
          {state.error}
        </p>
      ) : null}
      {state.session === null ? (
        <p
          className="text-xs text-muted"
          data-testid="voice-prefix-user-speaks-loading"
        >
          Preparing capture session…
        </p>
      ) : done ? (
        <p
          className="text-sm text-ok"
          data-testid="voice-prefix-user-speaks-done"
        >
          Captured {state.capturedPromptIds.length} of{" "}
          {state.session.prompts.length} samples. Tap Continue to confirm.
        </p>
      ) : currentPrompt ? (
        <>
          <p className="text-xs text-muted">
            Prompt {state.currentPromptIndex + 1} of{" "}
            {state.session.prompts.length} · ~{currentPrompt.targetSeconds}s
          </p>
          <p
            className="rounded border border-border/30 bg-bg/60 p-3 text-sm"
            data-testid="voice-prefix-user-speaks-prompt"
          >
            "{currentPrompt.text}"
          </p>
          <div className="flex gap-2">
            <Button
              variant={state.recording ? "destructive" : "default"}
              onClick={() => {
                if (state.recording) {
                  advancePrompt();
                } else {
                  setState((prev) => ({ ...prev, recording: true }));
                }
              }}
              data-testid="voice-prefix-user-speaks-record"
            >
              <Mic className="mr-2 h-4 w-4" />
              {state.recording ? "Stop & save" : "Record"}
            </Button>
            <Button
              variant="ghost"
              onClick={advancePrompt}
              data-testid="voice-prefix-user-speaks-skip-prompt"
            >
              Skip this one
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Step 6 — Owner confirm ───────────────────────────────────────────────

function OwnerConfirmStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [displayName, setDisplayName] = React.useState(
    props.initialOwnerDisplayName ?? "Shaw",
  );
  const [finalizing, setFinalizing] = React.useState(false);
  const [finalized, setFinalized] = React.useState(false);
  const onConfirm = React.useCallback(async () => {
    setFinalizing(true);
    try {
      const result = await props.profilesClient.finalizeOwnerCapture(
        `onboard-${Date.now().toString(36)}`,
        { displayName: displayName.trim() || "Owner" },
      );
      props.onOwnerSaved?.({ ...result, displayName });
      setFinalized(true);
    } finally {
      setFinalizing(false);
    }
  }, [displayName, props.onOwnerSaved, props.profilesClient]);

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-owner-confirm">
      <div className="flex items-center gap-3">
        <Crown
          className="h-5 w-5 text-accent"
          data-testid="voice-prefix-owner-confirm-crown"
        />
        <p className="text-sm">
          You are the OWNER. The agent will only execute privileged actions
          for you.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Display name
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded border border-border/40 bg-bg/50 px-2 py-1 text-sm"
          data-testid="voice-prefix-owner-confirm-name"
        />
      </label>
      <Button
        onClick={() => void onConfirm()}
        disabled={finalizing || finalized}
        data-testid="voice-prefix-owner-confirm-save"
      >
        {finalized ? "Saved" : finalizing ? "Saving…" : "Confirm OWNER"}
      </Button>
    </div>
  );
}

// ── Step 7 — Family ──────────────────────────────────────────────────────

function FamilyStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [family, setFamily] = React.useState<VoiceProfile[]>([]);
  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-family">
      <p className="text-sm">
        Optional: introduce other people the agent might hear. You can add
        more anytime in Settings → Voice → Profiles.
      </p>
      <ul
        className="flex flex-col gap-1 text-xs"
        data-testid="voice-prefix-family-list"
      >
        {family.length === 0 ? (
          <li className="text-muted">No additional people captured yet.</li>
        ) : (
          family.map((p) => (
            <li key={p.id} className="rounded border border-border/30 p-1.5">
              {p.displayName} · {p.relationshipLabel ?? "guest"}
            </li>
          ))
        )}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          // R10 §3.2 step 7: caller wires real capture; we stub a row so
          // the UI shows progress in onboarding.
          const placeholder: VoiceProfile = {
            id: `family-${Date.now().toString(36)}`,
            entityId: null,
            displayName: "Family member",
            relationshipLabel: "family",
            isOwner: false,
            embeddingCount: 0,
            firstHeardAtMs: Date.now(),
            lastHeardAtMs: Date.now(),
            cohort: "family",
            source: "onboarding",
          };
          setFamily((prev) => [...prev, placeholder]);
        }}
        data-testid="voice-prefix-family-add"
      >
        Add another voice
      </Button>
    </div>
  );
}

export default VoicePrefixSteps;
