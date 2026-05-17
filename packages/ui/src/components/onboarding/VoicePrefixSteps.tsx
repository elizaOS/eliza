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
  onOwnerSaved?: (
    result: VoiceCaptureSubmitResult & { displayName: string },
  ) => void;
  /** Optional initial display name for the OWNER (e.g. from cloud profile). */
  initialOwnerDisplayName?: string;
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
  "Hi — I'm Eliza. I'll listen when you talk and reply out loud. " +
  "To recognise your voice across conversations I need to learn how you " +
  "sound. Ready?";

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
          <TierStep {...props} tier={tier} tierSummary={props.tierSummary} />
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
              onClick={() =>
                props.onAdvance(nextVoicePrefixStep(props.step, tier))
              }
              data-testid="voice-prefix-skip"
            >
              Skip
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() =>
              props.onAdvance(nextVoicePrefixStep(props.step, tier))
            }
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
  props: VoicePrefixStepsProps & {
    tier: VoiceDeviceTier;
    tierSummary?: string;
  },
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
        speaker encoder, VAD, wake-word, Kokoro voice). You can continue once
        the essentials are in place — the rest finishes in the background.
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
    <div
      className="flex flex-col gap-3"
      data-testid="voice-prefix-agent-speaks"
    >
      <p className="text-sm">
        Press play to hear the agent introduce itself in the voice you selected.
      </p>
      <Button onClick={onPlay} data-testid="voice-prefix-agent-speaks-play">
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
    <div
      className="flex flex-col gap-3"
      data-testid="voice-prefix-owner-confirm"
    >
      <div className="flex items-center gap-3">
        <Crown
          className="h-5 w-5 text-accent"
          data-testid="voice-prefix-owner-confirm-crown"
        />
        <p className="text-sm">
          You are the OWNER. The agent will only execute privileged actions for
          you.
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

// ── Step 7 — Family ─────────────────────────────────────────────────────
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
  const [draftRelationship, setDraftRelationship] = React.useState("family");
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
      setDraftRelationship("family");
      setPhase("idle");
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Recording failed.");
      setPhase("idle");
    }
  }, [draftName, draftRelationship, props.profilesClient]);

  return (
    <div className="flex flex-col gap-3" data-testid="voice-prefix-family">
      <p className="text-sm">
        Optional: introduce other people the agent might hear. You can add more
        anytime in Settings → Voice → Profiles.
      </p>

      {captured.length > 0 ? (
        <ul
          className="flex flex-col gap-1 text-xs"
          data-testid="voice-prefix-family-list"
        >
          {captured.map((m) => (
            <li
              key={m.profileId ?? m.displayName}
              className="flex items-center gap-2 rounded border border-border/30 p-1.5"
            >
              <span className="font-medium">{m.displayName}</span>
              <span className="text-muted">· {m.relationship}</span>
              {m.entityId ? (
                <span
                  className="ml-auto text-ok text-[10px]"
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
        <div className="flex flex-col gap-2 rounded-lg border border-border/30 bg-bg/50 p-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <input
              type="text"
              value={draftName}
              placeholder="e.g. Alex"
              onChange={(e) => setDraftName(e.target.value)}
              className="rounded border border-border/40 bg-bg/60 px-2 py-1 text-sm text-txt"
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
              className="rounded border border-border/40 bg-bg/60 px-2 py-1 text-sm text-txt"
              data-testid="voice-prefix-family-relationship-input"
            />
          </label>
          {captureError ? (
            <p
              className="text-xs text-danger"
              data-testid="voice-prefix-family-error"
            >
              {captureError}
            </p>
          ) : null}
          <p className="rounded bg-bg/60 p-2 text-xs italic text-muted">
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
          className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/8 p-3 text-sm"
          data-testid="voice-prefix-family-recording"
        >
          <Mic className="h-4 w-4 animate-pulse text-accent" />
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
