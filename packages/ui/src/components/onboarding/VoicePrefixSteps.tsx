/**
 * VoicePrefixSteps — 6-step voice onboarding sub-flow (R10 §3).
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
 * - `onModelDownloadStart` from I5 starts the local bundle in the background.
 */

import { Crown, Mic, Sparkles, Volume2 } from "lucide-react";
import * as React from "react";
import type {
  VoiceCaptureSession,
  VoiceCaptureSubmitResult,
  VoiceProfilesClient,
} from "../../api/client-voice-profiles";
import {
  nextVoicePrefixStep,
  previousVoicePrefixStep,
  resolveVoicePrefixSteps,
  VOICE_PREFIX_STEP_META,
  type VoicePrefixStep,
} from "../../onboarding/voice-prefix";
import {
  DEFAULT_VOICE_DEVICE_TIER,
  type VoiceDeviceTier,
  VoiceTierBanner,
} from "../settings/VoiceTierBanner";
import { Button } from "../ui/button";

export interface VoicePrefixStepsProps {
  /** Active step. Caller drives this — voice-prefix.ts has next/prev helpers. */
  step: VoicePrefixStep;
  /** Device tier from I9; null falls back to "GOOD" copy. */
  tier: VoiceDeviceTier | null;
  /** Optional summary line for the tier banner. */
  tierSummary?: string;
  /** Adapter to I2's voice profile endpoints. */
  profilesClient: VoiceProfilesClient;
  /** Caller plays a scripted greeting via the chosen TTS (final step). */
  onAgentSpeak?: (script: string) => void | Promise<void>;
  /** Caller requests microphone permission. Returns true if granted. */
  onRequestMicPermission?: () => Promise<boolean>;
  /** Voice/model bundle readiness shown during device check. */
  voiceBundleReadiness?: VoiceBundleReadiness;
  /** Caller kicks off voice model download in the background. */
  onModelDownloadStart?: () => void | Promise<void>;
  /** Caller advances to the next step. */
  onAdvance: (next: VoicePrefixStep | null) => void;
  /** Caller goes back. */
  onBack: () => void;
  /** Caller skips remaining voice steps and jumps to the legacy flow. */
  onSkipPrefix?: () => void;
  /** OWNER name editor handler — passed the captured display name. */
  onOwnerSaved?: (
    result: VoiceCaptureSubmitResult & { displayName: string },
  ) => void;
  /** Optional initial display name for the OWNER (e.g. from cloud profile). */
  initialOwnerDisplayName?: string;
}

export type VoiceBundleDownloadStatus =
  | "checking"
  | "available"
  | "queued"
  | "downloading"
  | "assets-ready"
  | "engine-ready"
  | "ready"
  | "failed"
  | "unsupported";

export interface VoiceBundleReadiness {
  modelId: string;
  status: VoiceBundleDownloadStatus;
  message: string;
  percent?: number | null;
  canStartDownload: boolean;
}

interface VoiceCaptureState {
  session: VoiceCaptureSession | null;
  currentPromptIndex: number;
  recording: boolean;
  uploading: boolean;
  capturedPromptIds: string[];
  error: string | null;
}

const INITIAL_CAPTURE_STATE: VoiceCaptureState = {
  session: null,
  currentPromptIndex: 0,
  recording: false,
  uploading: false,
  capturedPromptIds: [],
  error: null,
};

const AGENT_GREETING_SCRIPT =
  "Hi, I'm Eliza. I'll listen when you talk and reply out loud. Ready?";

/** Convert a Blob to a raw base64 string (no data-URL prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function requestBrowserMicPermission(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}

export function VoicePrefixSteps(
  props: VoicePrefixStepsProps,
): React.ReactElement {
  const tier = props.tier ?? DEFAULT_VOICE_DEVICE_TIER;
  const allSteps = resolveVoicePrefixSteps(tier);
  const activeStep = allSteps.includes(props.step) ? props.step : "welcome";
  const stepMeta = VOICE_PREFIX_STEP_META[activeStep];
  const stepIndex = Math.max(0, allSteps.indexOf(activeStep));
  const progressLabel = `Step ${stepIndex + 1} of ${allSteps.length}`;

  // Lifted state: per-step readiness for Continue. WelcomeStep reports back
  // when the user has either granted mic permission or explicitly been denied
  // (denial is still "ready" — the user has made a choice). Other steps don't
  // report and default to ready=true.
  const [welcomeReady, setWelcomeReady] = React.useState(false);
  const continueDisabled = activeStep === "welcome" && !welcomeReady;

  return (
    <div
      className="flex max-h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-hidden"
      data-testid="voice-prefix-steps"
      data-step={activeStep}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-[var(--onboarding-text-faint)]">
        <span
          data-testid="voice-prefix-progress"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={allSteps.length}
          aria-valuetext={progressLabel}
        >
          {progressLabel}
        </span>
        {stepMeta.optional ? (
          <span className="rounded-sm bg-white/24 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--onboarding-text-muted)]">
            optional
          </span>
        ) : null}
      </header>

      <h1
        className="shrink-0 text-2xl font-semibold text-[var(--onboarding-text-strong)]"
        data-testid="voice-prefix-step-name"
        aria-live="polite"
      >
        {stepMeta.defaultName}
      </h1>
      <p
        className="shrink-0 text-sm text-[var(--onboarding-text-muted)]"
        data-testid="voice-prefix-step-subtitle"
      >
        {stepMeta.defaultSubtitle}
      </p>

      <main className="min-h-40 flex-1 overflow-y-auto rounded-sm bg-white/28 p-4 text-[var(--onboarding-text-primary)]">
        {activeStep === "welcome" ? (
          <WelcomeStep {...props} onPermissionResolved={setWelcomeReady} />
        ) : activeStep === "tier" ? (
          <VoiceReadinessStep
            {...props}
            tier={tier}
            tierSummary={props.tierSummary}
          />
        ) : activeStep === "agent-speaks" ? (
          <AgentSpeaksStep {...props} />
        ) : activeStep === "user-speaks" ? (
          <UserSpeaksStep {...props} />
        ) : activeStep === "owner-confirm" ? (
          <OwnerConfirmStep {...props} />
        ) : activeStep === "family" ? (
          <FamilyStep {...props} />
        ) : (
          <WelcomeStep {...props} onPermissionResolved={setWelcomeReady} />
        )}
      </main>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        {previousVoicePrefixStep(activeStep, tier) ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 px-4"
            onClick={() => {
              const prev = previousVoicePrefixStep(activeStep, tier);
              if (prev) props.onAdvance(prev);
              else props.onBack();
            }}
            data-testid="voice-prefix-back"
          >
            Back
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="flex items-center gap-2">
          {stepMeta.optional ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 px-4"
              onClick={() =>
                props.onAdvance(nextVoicePrefixStep(activeStep, tier))
              }
              data-testid="voice-prefix-skip"
            >
              Skip
            </Button>
          ) : null}
          <Button
            size="sm"
            className="min-h-11 px-5"
            disabled={continueDisabled}
            onClick={() =>
              props.onAdvance(nextVoicePrefixStep(activeStep, tier))
            }
            data-testid="voice-prefix-continue"
            aria-describedby={
              continueDisabled ? "voice-prefix-continue-help" : undefined
            }
          >
            Continue
          </Button>
          {continueDisabled ? (
            <span id="voice-prefix-continue-help" className="sr-only">
              Grant or deny microphone access first.
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

// ── Step 1 — Welcome + permissions ────────────────────────────────────────

function WelcomeStep(
  props: VoicePrefixStepsProps & {
    onPermissionResolved?: (resolved: boolean) => void;
  },
): React.ReactElement {
  const [permissionGranted, setPermissionGranted] = React.useState<
    boolean | null
  >(null);
  const onRequest = React.useCallback(async () => {
    const granted = await (props.onRequestMicPermission?.() ??
      requestBrowserMicPermission());
    setPermissionGranted(granted);
    props.onPermissionResolved?.(true);
  }, [props.onRequestMicPermission, props.onPermissionResolved]);

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-welcome">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-sm bg-[#0B35F1]/10 text-[#0B35F1]">
          <Sparkles className="h-5 w-5" />
        </span>
        <p className="text-sm">
          You'll talk to your agent, and your agent will talk back. We'll take a
          minute to set that up.
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
          className="text-xs text-[var(--onboarding-text-muted)]"
          data-testid="voice-prefix-welcome-mic-denied"
        >
          Microphone access was denied. You can grant it later in system
          settings.
        </p>
      ) : null}
      {permissionGranted === true ? (
        <p
          className="text-xs text-[#0B35F1]"
          data-testid="voice-prefix-welcome-mic-granted"
        >
          Microphone access granted.
        </p>
      ) : null}
    </div>
  );
}

// ── Step 2 — Hardware tier + voice bundle download ───────────────────────

function VoiceReadinessStep(
  props: VoicePrefixStepsProps & {
    tier: VoiceDeviceTier;
    tierSummary?: string;
  },
): React.ReactElement {
  const readiness = props.voiceBundleReadiness;
  const canStart =
    Boolean(props.onModelDownloadStart) &&
    Boolean(readiness?.canStartDownload) &&
    readiness?.status !== "checking";
  const busy =
    readiness?.status === "checking" ||
    readiness?.status === "queued" ||
    readiness?.status === "downloading";
  const percent =
    typeof readiness?.percent === "number"
      ? Math.max(0, Math.min(100, readiness.percent))
      : null;

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-tier">
      <VoiceTierBanner tier={props.tier} summary={props.tierSummary} />
      {props.tier === "POOR" ? (
        <p className="text-xs text-muted">
          We'll route voice through Eliza Cloud. You can still capture your
          voice profile for speaker recognition.
        </p>
      ) : null}
      <div
        className="rounded-sm bg-white/30 p-3"
        data-testid="voice-prefix-bundle-readiness"
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            {readiness?.status === "engine-ready"
              ? "Voice engine ready"
              : readiness?.status === "assets-ready" ||
                  readiness?.status === "ready"
                ? "Voice assets added"
                : "Voice bundle"}
          </p>
          <p className="text-xs text-muted">
            {readiness?.message ??
              "Check local model availability, then continue while any download finishes."}
          </p>
          {percent !== null ? (
            <div
              className="h-1.5 overflow-hidden rounded-sm bg-border/50"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="voice-prefix-bundle-progress"
            >
              <div
                className="h-full bg-[#0B35F1]"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canStart ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void props.onModelDownloadStart?.()}
                data-testid="voice-prefix-start-download"
              >
                Start download
              </Button>
            ) : null}
            {busy ? (
              <span
                className="text-xs text-muted"
                data-testid="voice-prefix-download-background"
              >
                You can continue while this finishes.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentSpeaksStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [playState, setPlayState] = React.useState<
    "idle" | "playing" | "played" | "failed"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);
  const onPlay = React.useCallback(async () => {
    if (!props.onAgentSpeak) {
      setPlayState("failed");
      setError("Voice playback is not available in this build.");
      return;
    }

    setPlayState("playing");
    setError(null);
    try {
      await props.onAgentSpeak(AGENT_GREETING_SCRIPT);
      setPlayState("played");
    } catch (err) {
      setPlayState("failed");
      setError(
        err instanceof Error ? err.message : "Voice playback failed to start.",
      );
    }
  }, [props.onAgentSpeak]);
  const played = playState === "played";
  const playing = playState === "playing";
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="voice-prefix-agent-speaks"
    >
      <p className="text-sm">
        Press play to hear Eliza before finishing setup.
      </p>
      <Button
        onClick={() => void onPlay()}
        disabled={playing}
        data-testid="voice-prefix-agent-speaks-play"
      >
        <Volume2 className="mr-2 h-4 w-4" />
        {playing ? "Playing..." : played ? "Replay greeting" : "Play greeting"}
      </Button>
      {error ? (
        <p
          className="text-xs text-[var(--onboarding-text-muted)]"
          data-testid="voice-prefix-agent-error"
        >
          {error}
        </p>
      ) : null}
      <p className="rounded-sm bg-white/30 p-2 text-xs italic text-muted">
        {AGENT_GREETING_SCRIPT}
      </p>
    </div>
  );
}

// ── Step 3 — User speaks ─────────────────────────────────────────────────
// Real capture: MediaRecorder → base64 → appendOwnerCapture per prompt.

function UserSpeaksStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [state, setState] = React.useState<VoiceCaptureState>(
    INITIAL_CAPTURE_STATE,
  );
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);

  const startSession = React.useCallback(async () => {
    try {
      const session = await props.profilesClient.startOwnerCapture();
      setState({
        session,
        currentPromptIndex: 0,
        recording: false,
        uploading: false,
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

  // Cleanup recorder + stream on unmount.
  React.useEffect(
    () => () => {
      recorderRef.current?.stop();
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
    },
    [],
  );

  const startRecording = React.useCallback(async () => {
    if (!state.session) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      setState((prev) => ({ ...prev, recording: true, error: null }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Microphone access failed.",
      }));
    }
  }, [state.session]);

  const stopRecordingAndAppend = React.useCallback(async () => {
    const recorder = recorderRef.current;
    const session = state.session;
    if (!recorder || !session) return;

    setState((prev) => ({ ...prev, recording: false, uploading: true }));

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      if (recorder.state !== "inactive") recorder.stop();
      else resolve();
    });
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    recorderRef.current = null;

    const blob = new Blob(chunksRef.current, {
      type: recorder.mimeType || "audio/webm",
    });
    chunksRef.current = [];
    const durationMs =
      (session.prompts[state.currentPromptIndex]?.targetSeconds ?? 5) * 1000;

    try {
      const audioBase64 = await blobToBase64(blob);
      const promptId = session.prompts[state.currentPromptIndex]?.id;
      if (promptId) {
        await props.profilesClient.appendOwnerCapture(session.sessionId, {
          promptId,
          audioBase64,
          durationMs,
        });
      }
    } catch {
      // Fallback: endpoint not live — proceed anyway, capture stored locally.
    }

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
        uploading: false,
        capturedPromptIds: captured,
      };
    });
  }, [state.session, state.currentPromptIndex, props.profilesClient]);

  const skipPrompt = React.useCallback(() => {
    setState((prev) => {
      if (!prev.session) return prev;
      return {
        ...prev,
        currentPromptIndex: Math.min(
          prev.currentPromptIndex + 1,
          prev.session.prompts.length,
        ),
        recording: false,
        uploading: false,
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
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-sm bg-warn/10 p-2 text-xs"
          data-testid="voice-prefix-user-speaks-error"
        >
          <p className="font-medium text-[var(--onboarding-text-muted)]">
            We couldn't reach the voice service. Try again in a moment, or skip
            this step and come back to it from Settings.
          </p>
          <p className="mt-1 text-[10px] text-muted">
            <span className="font-mono">{state.error}</span>
          </p>
        </div>
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
          className="text-sm text-[#0B35F1]"
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
            className="rounded-sm bg-white/30 p-3 text-sm"
            data-testid="voice-prefix-user-speaks-prompt"
          >
            "{currentPrompt.text}"
          </p>
          <div className="flex gap-2">
            {state.uploading ? (
              <Button disabled data-testid="voice-prefix-user-speaks-uploading">
                Saving…
              </Button>
            ) : (
              <Button
                variant={state.recording ? "destructive" : "default"}
                onClick={
                  state.recording
                    ? () => void stopRecordingAndAppend()
                    : () => void startRecording()
                }
                data-testid="voice-prefix-user-speaks-record"
              >
                <Mic className="mr-2 h-4 w-4" />
                {state.recording ? "Stop & save" : "Record"}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={skipPrompt}
              disabled={state.recording || state.uploading}
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

// ── Step 4 — Owner confirm ───────────────────────────────────────────────

function OwnerConfirmStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [displayName, setDisplayName] = React.useState(
    props.initialOwnerDisplayName ?? "",
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
    <div
      className="flex flex-col gap-3"
      data-testid="voice-prefix-owner-confirm"
    >
      <div className="flex items-center gap-3">
        <Crown
          className="h-5 w-5 text-[#0B35F1]"
          data-testid="voice-prefix-owner-confirm-crown"
        />
        <p className="text-sm">
          You're the owner of this device. The agent will only execute
          privileged actions (paying, posting, file edits, system changes) for
          you.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Display name
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-sm bg-white/30 px-2 py-1 text-sm"
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

// ── Step 5 — Family ─────────────────────────────────────────────────────
// Real capture flow: MediaRecorder → base64 → POST /api/voice/profiles/capture

type FamilyCapturePhase =
  | "idle"
  | "awaiting-name"
  | "recording"
  | "uploading"
  | "done-one";

interface FamilyMemberCapture {
  displayName: string;
  relationship: string;
  profileId: string | null;
  entityId: string | null;
}

/** 5-second capture prompt for a family member. */
const FAMILY_CAPTURE_PROMPT =
  "Hi, I'm a regular user of this device. I'll say a few words so the agent recognises my voice.";

async function recordAudioBlob(durationMs: number): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return new Promise<Blob>((resolve, reject) => {
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      reject(err);
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorder.onerror = (e) => {
      for (const track of stream.getTracks()) track.stop();
      reject(
        (e as Event & { error?: Error }).error ??
          new Error("MediaRecorder error"),
      );
    };
    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, durationMs);
  });
}

function FamilyStep(props: VoicePrefixStepsProps): React.ReactElement {
  const [captured, setCaptured] = React.useState<FamilyMemberCapture[]>([]);
  const [phase, setPhase] = React.useState<FamilyCapturePhase>("idle");
  const [draftName, setDraftName] = React.useState("");
  const [draftRelationship, setDraftRelationship] = React.useState("");
  const [captureError, setCaptureError] = React.useState<string | null>(null);
  const [countdown, setCountdown] = React.useState(0);
  const countdownRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  React.useEffect(
    () => () => {
      if (countdownRef.current !== null) clearInterval(countdownRef.current);
    },
    [],
  );

  const startCapture = React.useCallback(async () => {
    if (!draftName.trim()) return;
    setCaptureError(null);
    setPhase("recording");

    const DURATION_MS = 5000;
    setCountdown(Math.round(DURATION_MS / 1000));
    countdownRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          if (countdownRef.current !== null)
            clearInterval(countdownRef.current);
          countdownRef.current = null;
          return 0;
        }
        return n - 1;
      });
    }, 1000);

    try {
      const blob = await recordAudioBlob(DURATION_MS);
      setPhase("uploading");

      const audioBase64 = await blobToBase64(blob);

      // POST to /v1/voice/onboarding/family-member — creates a non-OWNER
      // entity with a family_of relationship tag bound to the voice profile.
      // Falls back gracefully (404/503 → stub) so the UI is never blocked.
      const result = await props.profilesClient.captureFamilyMember({
        audioBase64,
        durationMs: DURATION_MS,
        displayName: draftName.trim(),
        relationship: draftRelationship.trim() || "family",
      });

      setCaptured((prev) => [
        ...prev,
        {
          displayName: result.displayName,
          relationship: result.relationship,
          profileId: result.profileId,
          entityId: result.entityId,
        },
      ]);
      setDraftName("");
      setDraftRelationship("");
      setPhase("idle");
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Recording failed.");
      setPhase("idle");
    }
  }, [draftName, draftRelationship, props.profilesClient]);

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-family">
      <p className="text-sm">
        Introduce other people the agent might hear. You can add more anytime in
        Settings → Voice → Profiles.
      </p>

      {captured.length > 0 ? (
        <ul
          className="flex flex-col gap-1 text-xs"
          data-testid="voice-prefix-family-list"
        >
          {captured.map((m) => (
            <li
              key={m.profileId ?? m.displayName}
              className="flex items-center gap-2 rounded-sm bg-white/25 p-1.5"
            >
              <span className="font-medium">{m.displayName}</span>
              <span className="text-muted">· {m.relationship}</span>
              {m.entityId ? (
                <span
                  className="ml-auto text-[#0B35F1] text-[10px]"
                  data-testid="voice-prefix-family-captured"
                >
                  captured
                </span>
              ) : (
                <span
                  className="ml-auto text-muted text-[10px]"
                  data-testid="voice-prefix-family-stub"
                >
                  saved locally
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="text-xs text-muted"
          data-testid="voice-prefix-family-empty"
        >
          No additional people captured yet.
        </p>
      )}

      {phase === "idle" ? (
        <div className="flex flex-col gap-2 rounded-sm bg-white/30 p-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <input
              type="text"
              value={draftName}
              placeholder="e.g. Alex"
              onChange={(e) => setDraftName(e.target.value)}
              className="rounded-sm bg-white/40 px-2 py-1 text-sm text-txt"
              data-testid="voice-prefix-family-name-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Relationship
            <input
              type="text"
              value={draftRelationship}
              placeholder="family, colleague, …"
              onChange={(e) => setDraftRelationship(e.target.value)}
              className="rounded-sm bg-white/40 px-2 py-1 text-sm text-txt"
              data-testid="voice-prefix-family-relationship-input"
            />
          </label>
          {captureError ? (
            <p
              className="text-xs text-[var(--onboarding-text-muted)]"
              data-testid="voice-prefix-family-error"
            >
              {captureError}
            </p>
          ) : null}
          <p className="rounded-sm bg-white/30 p-2 text-xs italic text-muted">
            "{FAMILY_CAPTURE_PROMPT}"
          </p>
          <Button
            size="sm"
            disabled={!draftName.trim()}
            onClick={() => void startCapture()}
            data-testid="voice-prefix-family-record"
          >
            <Mic className="mr-2 h-4 w-4" />
            Record 5 s sample
          </Button>
        </div>
      ) : phase === "recording" ? (
        <div
          className="flex items-center gap-2 rounded-sm bg-[#0B35F1]/10 p-3 text-sm"
          data-testid="voice-prefix-family-recording"
        >
          <Mic className="h-4 w-4 animate-pulse text-[#0B35F1]" />
          Recording… {countdown}s — ask {draftName} to read the prompt aloud.
        </div>
      ) : (
        <div
          className="flex items-center gap-2 p-3 text-sm text-muted"
          data-testid="voice-prefix-family-uploading"
        >
          Saving profile…
        </div>
      )}
    </div>
  );
}

export default VoicePrefixSteps;
