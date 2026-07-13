/**
 * Headless, chat-native onboarding conductor.
 *
 * The typed flow in `first-run-flow.ts` is the control state. Transcript turns
 * are presentation only; provisioning lives in `first-run-finish.ts`.
 * Production is Cloud-only, while explicitly enabled developer builds may
 * offer local and remote runtimes.
 */

import { logger } from "@elizaos/logger";
import {
  hasStewardAuthedCookie,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import * as React from "react";
import type {
  ConversationMessage,
  ConversationSecretRequest,
  LocalAgentBackupMetadata,
} from "../api";
import { client } from "../api";
import {
  getCloudAuthToken,
  refreshCloudStewardSession,
} from "../api/client-cloud";
import { APP_RESUME_EVENT } from "../events";
import { ACCENT_PRESETS, useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { preOpenCloudLoginWindow } from "../state/cloud-login-launch";
import { hasUsableStoredStewardToken } from "../state/cloud-steward-login";
import { startTutorial } from "../tutorial/tutorial-service";
import { clearFirstRunTranscriptMessages } from "./clear-first-run-transcript";
import {
  peekDeviceRamTierAssessment,
  resolveDeviceRamTierAssessment,
} from "./device-ram-gate";
import {
  type DeviceRamTierAssessment,
  HYBRID_AGENT_MIN_MARKETED_RAM_GB,
  LOCAL_AGENT_MIN_MARKETED_RAM_GB,
} from "./device-ram-tier";
import { normalizeFirstRunName } from "./first-run";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
} from "./first-run-action-channel";
import {
  clearCloudLoginPending,
  markCloudLoginPending,
  readCloudLoginPending,
} from "./first-run-cloud-resume";
import {
  bindCloudAgent,
  type FirstRunFinishDraft,
  type FirstRunFinishOutcome,
  type FirstRunFinishPorts,
  listOrAutoProvisionCloudAgent,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run-finish";
import {
  type FirstRunActionGroup,
  type FirstRunFlowMode,
  type FirstRunFlowPhase,
  type FirstRunProvisioningVisibility,
  firstRunFlowPhase,
  isFirstRunFlowBusy,
  isFirstRunFlowProvisioned,
  isFirstRunFlowSilent,
  revealFirstRunFlow,
  routeFirstRunAction,
} from "./first-run-flow";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "./first-run-greeting";
import { isRuntimeChooserEnabled } from "./first-run-runtime-flag";
import { revertLocalRuntimeCommitment } from "./revert-local-runtime-commitment";

const GREETING = `${FIRST_RUN_GREETING} First, where should your agent run?`;

// Cloud-only greetings (#13377). The sign-in button reuses the runtime:cloud
// action value on purpose: the tap IS the user gesture that launches the real
// login flow (handleCloudLogin inside the provision flow — popup where one can
// open, same-tab /login navigation where popups are blocked or hostile,
// #15143). Keep this as one obvious CTA; the Cloud flow itself owns OAuth and
// provisioning, so there is no second in-chat "Connect" step.
const CLOUD_SIGN_IN_GREETING = FIRST_RUN_GREETING;
const CLOUD_SIGN_IN_CHOICE = [
  FIRST_RUN_SIGN_IN_PROMPT,
  "",
  "[CHOICE:first-run id=runtime]",
  `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Sign in to Eliza Cloud`,
  "[/CHOICE]",
].join("\n");
const CLOUD_WELCOME_BACK =
  "Welcome back — you're already signed in to Eliza Cloud. Setting up your agent…";
const CLOUD_ONLY_DONE =
  'You\'re all set — ask me anything. Want a quick tour? Type "restart tutorial" whenever you like.';

// Bounded cookie-recovery refresh at conductor mount (#15133). Mirrors
// STEWARD_RESTORE_REFRESH_TIMEOUT_MS in startup-phase-restore.ts so a hung
// same-origin refresh costs an authenticated console user at most this long of
// quiet empty chat before degrading to the normal sign-in greeting.
const FIRST_RUN_COOKIE_REFRESH_TIMEOUT_MS = 4_000;
const HANDOFF_NAVIGATION_GRACE_MS = 15_000;

// onStatus codes that mark a REAL provisioning wait — an actual agent create,
// a sandbox build, or a dedicated container's cold-boot wake. Every other code
// the finish path narrates ("setup" / "listing" / "ready" / "persist") wraps a
// couple of fast REST calls, which reads as fake provisioning theater to an
// already-signed-in user (#15133) — the silent entry drops those.
const REAL_PROVISION_STATUS_CODES = new Set([
  "creating",
  "provisioning",
  "starting",
]);

/** User-facing recovery message when a cloud provisioning call rejects. */
function cloudFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : "";
  return detail
    ? `Couldn't connect to Eliza Cloud: ${detail}.`
    : "Couldn't connect to Eliza Cloud.";
}

const RESTORE_GREETING =
  "I found an existing local backup for this device. Restore it before setup, or start fresh?";

function makeTurn(
  id: string,
  text: string,
  extra?: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: Date.now(),
    source: "first_run",
    ...extra,
  };
}

function newestLocalBackup(
  backups: LocalAgentBackupMetadata[],
): LocalAgentBackupMetadata | null {
  return (
    backups
      .slice()
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          b.fileName.localeCompare(a.fileName),
      )[0] ?? null
  );
}

// The "go back and change an earlier pick" option appended to every sub-step
// CHOICE (#14390): onboarding must never be forward-only. Its handler runs the
// reversal cleanup (revert-local-runtime-commitment.ts) before re-offering a
// fresh runtime choice, so backing out of a partially-committed local pick
// leaves no persisted mode, no local active server, and no running service.
const BACK_TO_RUNTIME_OPTION = `${FIRST_RUN_ACTION_PREFIX}back:runtime=← Back — change where your agent runs`;

// The first-run location chooser: Cloud (managed), On this device, or Remote
// (connect to an existing agent elsewhere). "Bring your own keys" is NOT a
// location — it lives one step later on the provider sub-choice as
// "Other / configure in Settings" (provider:other), which finishes the local
// runtime with `configure-later` and hands off provider setup to Settings via
// the finish path's banner. Remote picks an already-running agent by URL +
// token; it owns its own provider, so it skips the provider sub-step.
//
// Built per-render because the local option is RAM-tier-gated (#14390): on a
// device below the hybrid runtime floor it stays VISIBLE but labeled unavailable (never
// silently hidden), and its tap is refused with the reason. The tier probe is
// synchronous on Android; when it has not resolved yet (iOS first frames) the
// plain label renders and the pick handler + finish backstop still enforce.
function runtimeChoiceBlock(): string {
  const tier = peekDeviceRamTierAssessment();
  const localLabel =
    tier && !tier.allowsHybridAgent
      ? `On this device (unavailable — needs ${HYBRID_AGENT_MIN_MARKETED_RAM_GB} GB+ RAM, ~${tier.marketedRamGb} GB detected)`
      : "On this device";
  return [
    "[CHOICE:first-run id=runtime]",
    `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)`,
    `${FIRST_RUN_ACTION_PREFIX}runtime:local=${localLabel}`,
    `${FIRST_RUN_ACTION_PREFIX}runtime:remote=Connect to a remote agent`,
    "[/CHOICE]",
  ].join("\n");
}

const BACKUP_RESTORE_CHOICE = [
  "[CHOICE:first-run id=backup-restore]",
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:latest=Restore latest backup`,
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:start-fresh=Start fresh`,
  "[/CHOICE]",
].join("\n");

// RAM-tier-gated (#14390): below the 12 GB on-device-model floor the
// on-device option stays visible but labeled unavailable (its tap is refused
// with the reason) and the recommendation moves to Eliza Cloud inference —
// the local agent remains allowed in cloud-inference mode on that band.
function providerChoice(opts: {
  defaultId: "on-device" | "other";
  tier: DeviceRamTierAssessment | null;
}): string {
  const modelsBlocked = opts.tier != null && !opts.tier.allowsLocalModels;
  const onDevice = modelsBlocked
    ? `${FIRST_RUN_ACTION_PREFIX}provider:on-device=On this device (unavailable — needs 12 GB+ RAM, ~${opts.tier?.marketedRamGb} GB detected)`
    : `${FIRST_RUN_ACTION_PREFIX}provider:on-device=On this device (recommended)`;
  const cloud = modelsBlocked
    ? `${FIRST_RUN_ACTION_PREFIX}provider:elizacloud=Eliza Cloud inference (recommended)`
    : `${FIRST_RUN_ACTION_PREFIX}provider:elizacloud=Eliza Cloud inference`;
  const other = `${FIRST_RUN_ACTION_PREFIX}provider:other=Other / configure in Settings`;
  const configuredOther =
    opts.tier != null && !opts.tier.allowsLocalAgent
      ? `${FIRST_RUN_ACTION_PREFIX}provider:other=Other / configure in Settings (unavailable — needs ${LOCAL_AGENT_MIN_MARKETED_RAM_GB} GB+ RAM)`
      : other;
  const ordered = modelsBlocked
    ? [cloud, onDevice, configuredOther]
    : opts.defaultId === "on-device"
      ? [onDevice, cloud, configuredOther]
      : [configuredOther, onDevice, cloud];
  return [
    "[CHOICE:first-run id=provider]",
    ...ordered,
    BACK_TO_RUNTIME_OPTION,
    "[/CHOICE]",
  ].join("\n");
}

const TUTORIAL_CHOICE = [
  "[CHOICE:first-run id=tutorial]",
  `${FIRST_RUN_ACTION_PREFIX}tutorial:start=Take the tutorial`,
  `${FIRST_RUN_ACTION_PREFIX}tutorial:skip=Skip for now`,
  "[/CHOICE]",
].join("\n");

// Recovery choice seeded when a finish/provision flow fails (e.g. a 404 from
// POST /api/first-run). Every option here is a real way forward — retry the
// same runtime, pick a different one, or bail out to Settings — so a persistent
// finish error surfaces an escape instead of re-looping the runtime prompt
// and configure a provider by hand.
const ERROR_CHOICE = [
  "[CHOICE:first-run id=error]",
  `${FIRST_RUN_ACTION_PREFIX}error:retry=Try again`,
  `${FIRST_RUN_ACTION_PREFIX}error:restart=Choose a different way to run`,
  `${FIRST_RUN_ACTION_PREFIX}error:settings=Configure in Settings`,
  "[/CHOICE]",
].join("\n");

// Cloud-only recovery: with the runtime chooser off there is no "different way
// to run", so the restart option would be a dead end — retry and the Settings
// escape are the two real ways forward.
const CLOUD_ONLY_ERROR_CHOICE = [
  "[CHOICE:first-run id=error]",
  `${FIRST_RUN_ACTION_PREFIX}error:retry=Try again`,
  `${FIRST_RUN_ACTION_PREFIX}error:settings=Configure in Settings`,
  "[/CHOICE]",
].join("\n");

/**
 * Turn a raw finish error into a human sentence. The underlying message can be
 * a terse transport string ("Not found" for a 404, "Failed to fetch", …) that
 * means nothing to a first-run user; lead with a clear framing and keep the raw
 * detail for context. The recovery framing tracks the runtime chooser: with the
 * chooser off there is no "different way to run" to offer.
 */
function finishErrorMessage(message: string): string {
  const detail = message.trim();
  const isTerse = /^(not found|failed to fetch|forbidden|unauthorized)$/i.test(
    detail,
  );
  const lead = isTerse
    ? `I couldn't finish setting up your agent (${detail}).`
    : `I couldn't finish setting up your agent: ${detail}`;
  const recovery = isRuntimeChooserEnabled()
    ? "You can try again, pick a different way to run your agent, or configure a model provider yourself in Settings."
    : "You can try again, or configure a model provider yourself in Settings.";
  return `${lead}\n\n${recovery}`;
}

// The "make it yours" accent step. Reuses the shared ACCENT_PRESETS (the same
// list Appearance settings renders) so onboarding + Settings drive one
// persisted preference. In-chat CHOICE options render as text buttons, so each
// carries an emoji swatch to hint its color. Non-blocking: it's seeded next to
// the tutorial CHOICE, so a user who ignores it just taps the tutorial option;
// the `default` swatch keeps the brand accent.
const ACCENT_CHOICE = [
  "[CHOICE:first-run id=accent]",
  ...ACCENT_PRESETS.map(
    (p) => `${FIRST_RUN_ACTION_PREFIX}accent:${p.id}=${p.swatch} ${p.label}`,
  ),
  "[/CHOICE]",
].join("\n");

// The inline Remote connect form: a URL field + an optional access-token field.
// `delivery.canCollectValueInCurrentChannel` makes SensitiveRequestBlock render
// the form here on the owner's device; its `remote_connect` submit dispatches
// the hardened CONNECT_EVENT (validate URL → connect → adopt as the active
// runtime → finish first-run) rather than writing the values to the secret
// store — see SensitiveRequestBlock.handleSubmit.
function remoteConnectSecretRequest(): ConversationSecretRequest {
  return {
    key: "remote-agent",
    reason: "Connect to a remote agent by its URL and access token",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "remote_connect",
      mode: "inline_owner_app",
      fields: [
        {
          name: "url",
          label: "Remote agent URL",
          input: "text",
          required: true,
        },
        {
          name: "token",
          label: "Access token (optional)",
          input: "secret",
          required: false,
        },
      ],
      submitLabel: "Connect",
    },
  };
}

interface FirstRunTurnWriter {
  seedFreshChoiceTurn(
    baseId: string,
    text: string,
    extra?: Partial<ConversationMessage>,
  ): void;
}

export function surfaceCloudLoginRetryTurn(writer: FirstRunTurnWriter): void {
  // Append a fresh CHOICE card at the transcript tail. Replacing the original
  // OAuth turn can leave it hidden behind a later error/status/picker card, and
  // reusing an already-picked widget leaves its controls locked.
  const retryText = isRuntimeChooserEnabled()
    ? `Sign in to Eliza Cloud to continue. You can also pick how to run your agent again.\n\n${runtimeChoiceBlock()}`
    : CLOUD_SIGN_IN_CHOICE;
  writer.seedFreshChoiceTurn("first-run:cloud-oauth", retryText);
}

export function useFirstRunConductor(): void {
  const {
    firstRunComplete,
    firstRunName,
    completeFirstRun,
    elizaCloudConnected,
    handleCloudLogin,
    setTab,
    setState,
    setUiAccent,
    uiLanguage,
  } = useAppSelectorShallow((s) => ({
    firstRunComplete: s.firstRunComplete,
    firstRunName: s.firstRunName,
    completeFirstRun: s.completeFirstRun,
    elizaCloudConnected: s.elizaCloudConnected,
    handleCloudLogin: s.handleCloudLogin,
    setTab: s.setTab,
    setState: s.setState,
    setUiAccent: s.setUiAccent,
    uiLanguage: s.uiLanguage,
  }));
  const { setConversationMessages } = useConversationMessages();

  const active = firstRunComplete === false;
  const flowMode: FirstRunFlowMode = isRuntimeChooserEnabled()
    ? "runtime-chooser"
    : "cloud-only";
  const flowRef = React.useRef<FirstRunFlowPhase>(
    flowMode === "runtime-chooser"
      ? firstRunFlowPhase.choosingRuntime()
      : firstRunFlowPhase.signingIn(),
  );
  const choiceTurnSeqRef = React.useRef(0);

  const draftRef = React.useRef<FirstRunFinishDraft>({
    agentName: normalizeFirstRunName(firstRunName) || "Eliza",
    runtime: "cloud",
    localInference: "all-local",
    remoteApiBase: "",
    remoteToken: "",
  });
  const cloudPrefsRef = React.useRef<{
    preferAgentId?: string;
    forceCreate?: boolean;
  }>({});
  const latestLocalBackupRef = React.useRef<LocalAgentBackupMetadata | null>(
    null,
  );

  // ── Transcript seam ──────────────────────────────────────────────────────
  const seedTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === turn.id) ? prev : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  // Seed a CHOICE turn that must arrive unlocked on every re-offer. A choice
  // widget locks itself after its first pick, and `seedTurn` dedups by id — so
  // re-offering into an existing turn would present a dead (locked) widget.
  // When the base turn already exists, seed a fresh retry turn instead.
  const seedFreshChoiceTurn = React.useCallback(
    (baseId: string, text: string, extra?: Partial<ConversationMessage>) => {
      setConversationMessages((prev) => {
        if (!prev.some((m) => m.id === baseId)) {
          return [...prev, makeTurn(baseId, text, extra)];
        }
        let retryId: string;
        do {
          choiceTurnSeqRef.current += 1;
          retryId = `${baseId}:retry:${choiceTurnSeqRef.current}`;
        } while (prev.some((message) => message.id === retryId));
        return [...prev, makeTurn(retryId, text, extra)];
      });
    },
    [setConversationMessages],
  );

  const seedTutorial = React.useCallback(() => {
    flowRef.current = firstRunFlowPhase.wrapUp();
    // "Make it yours" — the accent step is seeded alongside the tutorial prompt
    // so it never blocks finishing: a user who ignores it just taps a tutorial
    // option below. Picking a swatch applies + persists the accent live.
    seedTurn(
      makeTurn(
        "first-run:appearance",
        `First, make it yours — pick an accent color (or keep the default and continue below).\n\n${ACCENT_CHOICE}`,
      ),
    );
    seedTurn(
      makeTurn(
        "first-run:tutorial",
        `You're all set. Want a quick tour?\n\n${TUTORIAL_CHOICE}`,
      ),
    );
  }, [seedTurn]);

  const seedRuntimeChoice = React.useCallback(() => {
    flowRef.current = firstRunFlowPhase.choosingRuntime();
    seedTurn(
      makeTurn("first-run:greeting", `${GREETING}\n\n${runtimeChoiceBlock()}`),
    );
  }, [seedTurn]);

  // Cloud-only completion (#13377): signing in IS onboarding. The moment
  // provisioning succeeds we flip the real gate — no tutorial/accent pick gates
  // completion in this mode (the chat-native tutorial remains command-driven).
  const completeCloudOnly = React.useCallback(() => {
    if (flowRef.current.kind === "complete") return;
    const completedSilently = isFirstRunFlowSilent(flowRef.current);
    flowRef.current = firstRunFlowPhase.complete();
    // A silent entry that STAYED silent was a pure reuse (#15133): the user is
    // already signed in and their agent already exists — land straight in chat
    // with no wrap-up turn. A create/wake path cleared the ref on its first
    // real provisioning status, so its wrap-up still renders.
    if (!completedSilently) {
      seedTurn(makeTurn("first-run:cloud-done", CLOUD_ONLY_DONE));
    }
    completeFirstRun("chat");
  }, [seedTurn, completeFirstRun]);

  const seedBackupRestoreChoice = React.useCallback(
    (backups: LocalAgentBackupMetadata[]) => {
      const latest = newestLocalBackup(backups);
      // The greeting + runtime choice is already seeded on mount, so there is
      // nothing to fall back to when there is no restorable backup.
      if (!latest) return;
      latestLocalBackupRef.current = latest;
      // Offer restore as an ADDITIONAL turn below the greeting — but only while
      // the user has NOT advanced past it (picking a runtime seeds a
      // provider / cloud-oauth / remote-connect / tutorial / error turn, all
      // source "first_run" with a non-greeting id). The atomic updater also
      // prevents a double-seed if the backup probe ever fires twice (the
      // restore turn itself is source "first_run" + non-greeting id).
      setConversationMessages((prev) => {
        const advancedPastGreeting = prev.some(
          (m) => m.source === "first_run" && m.id !== "first-run:greeting",
        );
        if (advancedPastGreeting) return prev;
        return [
          ...prev,
          makeTurn(
            "first-run:backup-restore",
            `${RESTORE_GREETING}\n\n${BACKUP_RESTORE_CHOICE}`,
          ),
        ];
      });
    },
    [setConversationMessages],
  );

  // Ports for the headless finish use case. completeFirstRun is INTERCEPTED:
  // with the runtime chooser on, provisioning calls it, we record + offer the
  // tutorial, and only flip the real gate when the user picks a tutorial
  // option. In cloud-only mode the intercept completes for real immediately.
  const ports = React.useMemo<FirstRunFinishPorts>(
    () => ({
      uiLanguage,
      elizaCloudConnected,
      handleCloudLogin,
      preOpenWindow: preOpenCloudLoginWindow,
      setRuntimeState: (key, value) => {
        setState(key, value as never);
      },
      setTab,
      completeFirstRun: () => {
        if (flowMode === "runtime-chooser") {
          seedTutorial();
          return;
        }
        completeCloudOnly();
      },
      onStatus: (text, code) => {
        if (!text) return;
        if (isFirstRunFlowSilent(flowRef.current)) {
          // Silent cloud entry (#15133): reuse narration ("Setting up your
          // cloud agent", "Finding your agents...", "Connected to your
          // agent", "Saving first-run profile") wraps two fast REST calls —
          // provisioning theater for someone who already has an agent. Only
          // a REAL wait breaks the silence: an actual create, a sandbox
          // build, or a dedicated cold-boot wake take genuinely long, so
          // clear the ref and narrate honestly from that point on.
          if (!code || !REAL_PROVISION_STATUS_CODES.has(code)) return;
          flowRef.current = revealFirstRunFlow(flowRef.current);
        }
        seedTurn(makeTurn(`first-run:status:${text}`, text));
      },
    }),
    [
      uiLanguage,
      elizaCloudConnected,
      handleCloudLogin,
      setState,
      setTab,
      flowMode,
      seedTutorial,
      completeCloudOnly,
      seedTurn,
    ],
  );
  const portsRef = React.useRef(ports);
  portsRef.current = ports;

  const seedError = React.useCallback(
    (message: string) => {
      flowRef.current = firstRunFlowPhase.error(message);
      // A DISTINCT, non-looping error surface: the error turn carries its own
      // recovery choice (retry / restart / Settings escape) so onboarding is
      // always recoverable. It must NOT re-append the runtime CHOICE — that
      // would re-offer the same runtime question forever with no way out on a
      // persistent finish error (e.g. the /api/first-run 404).
      seedFreshChoiceTurn(
        "first-run:error:card",
        `${finishErrorMessage(message)}\n\n${flowMode === "runtime-chooser" ? ERROR_CHOICE : CLOUD_ONLY_ERROR_CHOICE}`,
      );
    },
    [flowMode, seedFreshChoiceTurn],
  );

  // Explicit, non-finish escape hatch out of onboarding: flip the real gate and
  // land the user in Settings so they can wire a model provider by hand. Used
  // ONLY by the error-recovery "Configure in Settings" choice, so a broken
  // finish never traps the user in the loop.
  const exitToSettings = React.useCallback(() => {
    if (flowRef.current.kind === "complete") return;
    flowRef.current = firstRunFlowPhase.complete();
    setTab("settings");
    completeFirstRun("settings");
  }, [setTab, completeFirstRun]);

  const seedCloudAgentChoice = React.useCallback(
    (agents: { id?: string; name?: string }[]) => {
      flowRef.current = firstRunFlowPhase.choosingCloudAgent();
      const lines = agents
        .filter((a): a is { id: string; name?: string } => Boolean(a.id))
        .map(
          (a) =>
            `${FIRST_RUN_ACTION_PREFIX}cloud-agent:${a.id}=${a.name?.trim() || a.id}`,
        );
      lines.push(
        `${FIRST_RUN_ACTION_PREFIX}cloud-agent:new=Create a new agent`,
      );
      // Cloud-only mode has no runtime to go back to; only offer the back
      // affordance when the chooser owns this flow.
      if (flowMode === "runtime-chooser") {
        lines.push(BACK_TO_RUNTIME_OPTION);
      }
      seedFreshChoiceTurn(
        "first-run:cloud-agent",
        `Which Eliza Cloud agent should I use?\n\n[CHOICE:first-run id=cloud-agent]\n${lines.join("\n")}\n[/CHOICE]`,
      );
    },
    [flowMode, seedFreshChoiceTurn],
  );

  // Armed by a needs-cloud-login outcome; consumed by the auto-resume effect
  // when the cloud connection lands (or cleared by the user's next pick).
  const pendingCloudResumeRef = React.useRef<"cloud" | "hybrid" | null>(null);
  const handoffRecoveryTimerRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const clearHandoffRecovery = React.useCallback(() => {
    if (handoffRecoveryTimerRef.current) {
      clearTimeout(handoffRecoveryTimerRef.current);
      handoffRecoveryTimerRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", clearHandoffRecovery);
    return () => {
      window.removeEventListener("pagehide", clearHandoffRecovery);
    };
  }, [clearHandoffRecovery]);
  // Bind tail for a chosen/auto-chosen cloud agent. The ref breaks its callback
  // cycle with handleOutcome; the flow phase prevents concurrent binds.
  const bindCloudAgentByIdRef = React.useRef<((id: string) => void) | null>(
    null,
  );
  // Live mirror of elizaCloudConnected for call-time reads inside callbacks that
  // must NOT list it as a dep (adding it re-registers the action handler and
  // re-seeds on every connection change). It also gates the needs-cloud-login
  // re-arm below so a stale-but-"connected" token can't spin the resume loop.
  const elizaCloudConnectedRef = React.useRef(elizaCloudConnected);
  elizaCloudConnectedRef.current = elizaCloudConnected;

  const handleOutcome = React.useCallback(
    (outcome: FirstRunFinishOutcome) => {
      switch (outcome.kind) {
        case "done":
          // provisioning's completeFirstRun port already ran the wrap-up
          // (tutorial offer, or the cloud-only real completion).
          if (!isFirstRunFlowProvisioned(flowRef.current)) {
            if (flowMode === "runtime-chooser") seedTutorial();
            else completeCloudOnly();
          }
          return;
        case "handoff-started":
          // The handoff normally unloads this document. If navigation is
          // blocked by a WebView/CSP/beforeunload edge, re-offer a usable retry
          // instead of leaving onboarding permanently busy.
          flowRef.current = firstRunFlowPhase.handoff();
          clearHandoffRecovery();
          handoffRecoveryTimerRef.current = setTimeout(() => {
            handoffRecoveryTimerRef.current = null;
            if (flowRef.current.kind !== "handoff") return;
            flowRef.current =
              flowMode === "runtime-chooser"
                ? firstRunFlowPhase.choosingRuntime()
                : firstRunFlowPhase.signingIn();
            surfaceCloudLoginRetryTurn({ seedFreshChoiceTurn });
          }, HANDOFF_NAVIGATION_GRACE_MS);
          return;
        case "pick-cloud-agent": {
          // Compatibility path for any legacy/stale picker outcome. The main
          // Cloud first-run path now binds the best healthy agent directly so
          // onboarding stays a single sign-in flow.
          if (flowMode === "cloud-only") {
            const first = outcome.agents[0]?.agent_id;
            if (outcome.agents.length === 1 && first) {
              bindCloudAgentByIdRef.current?.(first);
              return;
            }
          }
          seedCloudAgentChoice(
            outcome.agents.map((a) => ({ id: a.agent_id, name: a.agent_name })),
          );
          return;
        }
        case "needs-cloud-login": {
          // Arm auto-resume ONLY when not already connected. If elizaCloudConnected
          // already reads true yet the bind still reported needs-cloud-login, the
          // stored token is stale/invalid (getCloudAuthToken shadowed empty) — arming
          // would let the auto-resume effect (gated on elizaCloudConnected) re-fire at
          // once and spin the provision→fail→re-arm loop that spammed the transcript
          // (#14387). Show the retry turn and wait for a genuine re-auth (a false→true
          // flip re-enables resume); its sign-in tap re-enters the flow meanwhile.
          pendingCloudResumeRef.current = elizaCloudConnectedRef.current
            ? null
            : draftRef.current.runtime === "cloud"
              ? "cloud"
              : "hybrid";
          flowRef.current =
            flowMode === "runtime-chooser"
              ? firstRunFlowPhase.choosingRuntime()
              : firstRunFlowPhase.signingIn();
          surfaceCloudLoginRetryTurn({ seedFreshChoiceTurn });
          return;
        }
        case "error":
          seedError(outcome.message);
          return;
      }
    },
    [
      seedTutorial,
      completeCloudOnly,
      seedCloudAgentChoice,
      seedError,
      flowMode,
      clearHandoffRecovery,
      seedFreshChoiceTurn,
    ],
  );

  // ── Flow launchers (shared by the action handler + the auto-resume) ──────
  const startCloudProvisionFlow = React.useCallback(
    (visibility: FirstRunProvisioningVisibility = "visible") => {
      flowRef.current = firstRunFlowPhase.provisioning(visibility);
      const ports = portsRef.current;
      const preOpenedAuthWindow = ports.preOpenWindow?.() ?? null;
      let preOpenedAuthWindowClaimed = false;
      const closePreOpenedAuthWindow = () => {
        if (!preOpenedAuthWindow) return;
        try {
          preOpenedAuthWindow.close();
        } catch (error) {
          void error;
          // error-policy:J6 best-effort cleanup for an auth popup we no longer need.
        }
      };
      const flowPorts: FirstRunFinishPorts = {
        ...ports,
        preOpenWindow: () => {
          preOpenedAuthWindowClaimed = true;
          return preOpenedAuthWindow;
        },
      };
      void listOrAutoProvisionCloudAgent(draftRef.current, flowPorts)
        .then((outcome) => {
          if (
            outcome.kind === "done" ||
            outcome.kind === "pick-cloud-agent" ||
            outcome.kind === "handoff-started"
          ) {
            // Login resolved + provisioning is proceeding — the resume marker has
            // served its purpose; drop it so a later relaunch doesn't re-resume.
            clearCloudLoginPending();
            closePreOpenedAuthWindow();
          }
          handleOutcome(outcome);
        })
        // error-policy:J4 unlike runFirstRunFinish (which funnels throws to
        // seedError), these cloud entrypoints can reject (OAuth/network);
        // without this a rejected OAuth/provision call strands the user with no
        // recovery action.
        .catch((err: unknown) => seedError(cloudFailureMessage(err)))
        .finally(() => {
          if (preOpenedAuthWindow && !preOpenedAuthWindowClaimed) {
            closePreOpenedAuthWindow();
          }
        });
    },
    [handleOutcome, seedError],
  );

  const startProviderFinish = React.useCallback(() => {
    flowRef.current = firstRunFlowPhase.provisioning();
    void runFirstRunFinish(draftRef.current, portsRef.current).then(
      handleOutcome,
    );
  }, [handleOutcome]);

  // Continue an interrupted cloud/hybrid flow once the connection is present.
  // Shared by (a) the auto-resume effect below — used when the user connects
  // from the retry turn's OAuth block and the store later learns the connection
  // landed — and (b) the mount-time cloud-login rehydrate, which calls this
  // directly when the durable token already made the connection live at launch
  // (the effect fired once before the marker was armed, so it can't self-fire).
  const runCloudResume = React.useCallback(
    (
      resume: "cloud" | "hybrid",
      visibility: FirstRunProvisioningVisibility = "visible",
    ) => {
      if (
        isFirstRunFlowBusy(flowRef.current) ||
        isFirstRunFlowProvisioned(flowRef.current)
      ) {
        return;
      }
      pendingCloudResumeRef.current = null;
      if (resume === "cloud") {
        startCloudProvisionFlow(visibility);
        return;
      }
      startProviderFinish();
    },
    [startCloudProvisionFlow, startProviderFinish],
  );

  // The one bind tail for a cloud agent, shared by the picker tap and the
  // cloud-only auto-adopt path.
  const bindCloudAgentById = React.useCallback(
    (id: string) => {
      const authToken = getCloudAuthToken(client) ?? "";
      if (!authToken) {
        handleOutcome({ kind: "needs-cloud-login" });
        return;
      }
      cloudPrefsRef.current =
        id === "new" ? { forceCreate: true } : { preferAgentId: id };
      const visibility: FirstRunProvisioningVisibility = isFirstRunFlowSilent(
        flowRef.current,
      )
        ? "silent"
        : "visible";
      flowRef.current = firstRunFlowPhase.provisioning(visibility);
      void bindCloudAgent(
        draftRef.current,
        authToken,
        cloudPrefsRef.current,
        portsRef.current,
      )
        .then(handleOutcome)
        // error-policy:J4 bind failure is surfaced as an onboarding error turn
        .catch((err: unknown) => seedError(cloudFailureMessage(err)));
    },
    [handleOutcome, seedError],
  );
  bindCloudAgentByIdRef.current = bindCloudAgentById;

  // Read-only mirror so the auto-resume effect + the mount rehydrate can drive
  // runCloudResume without listing it as a dep. Its identity churns as its own
  // flow-launcher deps change; the effect below depending on it re-fired on
  // every seeded-turn render and, on a stale token, spun the
  // provision→fail→re-arm loop (#14387).
  const runCloudResumeRef = React.useRef(runCloudResume);
  runCloudResumeRef.current = runCloudResume;

  // Auto-resume: when the user connects Eliza Cloud from the retry turn's OAuth
  // block (instead of re-picking a runtime), continue the interrupted flow the
  // moment the store learns the connection landed. Fires AT MOST ONCE per
  // connection epoch: a resume that lands back on needs-cloud-login (stale token)
  // must not immediately re-fire — that is the loop that spammed the onboarding
  // transcript (#14387). A fresh false→true connection flip clears the latch and
  // re-enables resume; the retry turn's sign-in tap re-enters the flow meanwhile.
  // A fresh pick clears the pending marker, so the user's latest intent wins.
  const resumedForConnectionRef = React.useRef(false);
  React.useEffect(() => {
    if (!active || !elizaCloudConnected) {
      resumedForConnectionRef.current = false;
      return;
    }
    if (resumedForConnectionRef.current) return;
    const resume = pendingCloudResumeRef.current;
    if (!resume) return;
    resumedForConnectionRef.current = true;
    runCloudResumeRef.current(resume);
  }, [active, elizaCloudConnected]);

  const handleRuntimeAction = React.useCallback(
    (id: string) => {
      switch (id) {
        case "cloud":
          void revertLocalRuntimeCommitment();
          draftRef.current = {
            ...draftRef.current,
            runtime: "cloud",
            localInference: "cloud-inference",
          };
          markCloudLoginPending({
            runtime: "cloud",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
          startCloudProvisionFlow();
          return;
        case "remote": {
          void revertLocalRuntimeCommitment();
          flowRef.current = firstRunFlowPhase.connectingRemote();
          seedFreshChoiceTurn(
            "first-run:remote-connect",
            `Enter your remote agent's URL and access token to connect.\n\n[CHOICE:first-run id=remote-back]\n${BACK_TO_RUNTIME_OPTION}\n[/CHOICE]`,
            { secretRequest: remoteConnectSecretRequest() },
          );
          return;
        }
        case "local": {
          const tier = peekDeviceRamTierAssessment();
          if (tier && !tier.allowsHybridAgent) {
            seedTurn(
              makeTurn(
                `first-run:runtime-blocked:${Date.now()}`,
                `I can't run on this device — ${tier.reason}. Eliza Cloud runs your agent with nothing to install, or you can connect to an agent running somewhere else.\n\n${runtimeChoiceBlock()}`,
              ),
            );
            return;
          }
          draftRef.current = {
            ...draftRef.current,
            runtime: "local",
            localInference: "all-local",
          };
          flowRef.current = firstRunFlowPhase.choosingProvider();
          const modelWarning =
            tier && (tier.localModelsWarning || !tier.allowsLocalModels)
              ? ` Heads up: ${tier.reason}.`
              : "";
          seedFreshChoiceTurn(
            "first-run:provider",
            `Which model provider should ${draftRef.current.agentName} use?${modelWarning}\n\n${providerChoice({ defaultId: "on-device", tier })}`,
          );
          return;
        }
        default:
          return;
      }
    },
    [seedFreshChoiceTurn, seedTurn, startCloudProvisionFlow],
  );

  const handleBackupRestoreAction = React.useCallback(
    (id: string) => {
      if (id === "start-fresh") {
        latestLocalBackupRef.current = null;
        flowRef.current = firstRunFlowPhase.choosingRuntime();
        seedFreshChoiceTurn(
          "first-run:greeting",
          `${GREETING}\n\n${runtimeChoiceBlock()}`,
        );
        return;
      }
      if (id !== "latest") return;
      const backup = latestLocalBackupRef.current;
      if (!backup) return;

      flowRef.current = firstRunFlowPhase.restoringBackup();
      seedFreshChoiceTurn(
        "first-run:backup-restore-status",
        `Restoring the latest local backup… If it takes too long, choose another way to run your agent.\n\n${runtimeChoiceBlock()}`,
      );
      void client
        .restoreLocalAgentBackup(backup.fileName)
        .then(() => {
          if (flowRef.current.kind !== "restoring-backup") return;
          seedFreshChoiceTurn(
            "first-run:backup-restore-complete",
            `Backup restored. Restart the agent to use the restored state, or continue with a new setup.\n\n${runtimeChoiceBlock()}`,
          );
        })
        .catch((error) => {
          if (flowRef.current.kind !== "restoring-backup") return;
          const message =
            error instanceof Error ? error.message : String(error);
          seedFreshChoiceTurn(
            "first-run:backup-restore-error",
            `Restore failed: ${message}\n\n${BACKUP_RESTORE_CHOICE}`,
          );
        })
        .finally(() => {
          if (flowRef.current.kind === "restoring-backup") {
            flowRef.current = firstRunFlowPhase.choosingRuntime();
          }
        });
    },
    [seedFreshChoiceTurn],
  );

  const handleProviderAction = React.useCallback(
    (id: string) => {
      const tier = peekDeviceRamTierAssessment();
      switch (id) {
        case "on-device":
          if (tier && !tier.allowsLocalModels) {
            seedFreshChoiceTurn(
              "first-run:provider",
              `On-device models won't work here — ${tier.reason}. Eliza Cloud inference keeps the agent on this device and runs the models in the cloud.\n\n${providerChoice({ defaultId: "on-device", tier })}`,
            );
            return;
          }
          draftRef.current = {
            ...draftRef.current,
            localInference: "all-local",
          };
          break;
        case "elizacloud":
          draftRef.current = {
            ...draftRef.current,
            localInference: "cloud-inference",
          };
          markCloudLoginPending({
            runtime: "hybrid",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
          break;
        case "other":
          if (tier && !tier.allowsLocalAgent) {
            seedFreshChoiceTurn(
              "first-run:provider",
              `An unconfigured local runtime won't work here — ${tier.reason}. Eliza Cloud inference keeps the agent on this device without loading a local model.\n\n${providerChoice({ defaultId: "other", tier })}`,
            );
            return;
          }
          draftRef.current = {
            ...draftRef.current,
            localInference: "configure-later",
          };
          break;
        default:
          return;
      }
      startProviderFinish();
    },
    [seedFreshChoiceTurn, startProviderFinish],
  );

  const handleBackAction = React.useCallback(
    (id: string) => {
      if (id !== "runtime") return;
      void revertLocalRuntimeCommitment();
      draftRef.current = {
        ...draftRef.current,
        runtime: "cloud",
        localInference: "all-local",
      };
      cloudPrefsRef.current = {};
      flowRef.current = firstRunFlowPhase.choosingRuntime();
      seedFreshChoiceTurn(
        "first-run:greeting",
        `${GREETING}\n\n${runtimeChoiceBlock()}`,
      );
    },
    [seedFreshChoiceTurn],
  );

  const handleErrorAction = React.useCallback(
    (id: string) => {
      switch (id) {
        case "settings":
          exitToSettings();
          return;
        case "restart":
          void revertLocalRuntimeCommitment();
          flowRef.current = firstRunFlowPhase.choosingRuntime();
          seedFreshChoiceTurn(
            "first-run:greeting",
            `${GREETING}\n\n${runtimeChoiceBlock()}`,
          );
          return;
        case "retry":
          if (draftRef.current.runtime === "cloud") {
            startCloudProvisionFlow();
          } else {
            startProviderFinish();
          }
          return;
        default:
          return;
      }
    },
    [
      exitToSettings,
      seedFreshChoiceTurn,
      startCloudProvisionFlow,
      startProviderFinish,
    ],
  );

  const handleAccentAction = React.useCallback(
    (id: string) => {
      if (ACCENT_PRESETS.some((preset) => preset.id === id)) setUiAccent(id);
    },
    [setUiAccent],
  );

  const handleTutorialAction = React.useCallback(
    (id: string) => {
      if (id !== "start" && id !== "skip") return;
      flowRef.current = firstRunFlowPhase.complete();
      completeFirstRun("chat");
      if (id === "start") startTutorial();
    },
    [completeFirstRun],
  );

  const actionHandlers = React.useMemo<
    Record<FirstRunActionGroup, (id: string) => void>
  >(
    () => ({
      runtime: handleRuntimeAction,
      "backup-restore": handleBackupRestoreAction,
      provider: handleProviderAction,
      "cloud-agent": (id) => bindCloudAgentByIdRef.current?.(id),
      back: handleBackAction,
      error: handleErrorAction,
      accent: handleAccentAction,
      tutorial: handleTutorialAction,
    }),
    [
      handleAccentAction,
      handleBackAction,
      handleBackupRestoreAction,
      handleErrorAction,
      handleProviderAction,
      handleRuntimeAction,
      handleTutorialAction,
    ],
  );

  const handleFirstRunAction = React.useCallback(
    (value: string): boolean => {
      const route = routeFirstRunAction(flowRef.current, value, {
        mode: flowMode,
      });
      switch (route.kind) {
        case "pass-through":
          return false;
        case "consume":
          return true;
        case "dispatch":
          pendingCloudResumeRef.current = null;
          clearCloudLoginPending();
          actionHandlers[route.action.group](route.action.id);
          return true;
      }
    },
    [actionHandlers, flowMode],
  );
  const handleActionRef = React.useRef(handleFirstRunAction);
  handleActionRef.current = handleFirstRunAction;

  // Register the interceptor + seed the greeting while onboarding is active.
  React.useEffect(() => {
    if (!active) {
      clearHandoffRecovery();
      setFirstRunActionHandler(null);
      // Onboarding just completed: the overlay stops filtering the transcript to
      // the current first-run card (`selectFirstRunDisplayMessages`) and renders
      // the raw store, so every synthetic `first-run:*` turn the conductor
      // seeded (greeting + welcome-back + cloud-done) would
      // otherwise paint as stacked real chat bubbles — the first message then
      // looks duplicated into multiple greetings + doubled user turns until the
      // first send's history reload full-replaces the store (#15354). Drop them
      // now so the real chat opens on a clean thread. Pure id/source-scoped
      // filter: it never touches a real server or optimistic `temp-*` turn, and
      // is a no-op when onboarding seeded nothing (silent reuse, #15133).
      setConversationMessages(clearFirstRunTranscriptMessages);
      return;
    }
    resetFirstRunPersistGuard();
    flowRef.current =
      flowMode === "runtime-chooser"
        ? firstRunFlowPhase.choosingRuntime()
        : firstRunFlowPhase.signingIn();
    // Warm the RAM-tier probe (#14390) so the pick handlers' synchronous
    // `peek` has an answer by the time a human can tap: Android resolves
    // synchronously inside peek anyway; this covers the iOS async path. Never
    // gates the greeting — the finish backstop enforces the policy even when
    // a pick lands before the probe settles.
    void resolveDeviceRamTierAssessment();
    setFirstRunActionHandler((value) => handleActionRef.current(value));
    // Cloud-only onboarding (#13377): sign in to Eliza Cloud is the single
    // path. An already-usable session (hosted web where the user is logged in
    // to Eliza Cloud, a durable token from a previous login, a completed
    // OAuth round trip after a mobile WebView eviction, or a session
    // recovered from the console's cross-subdomain cookie) enters SILENTLY
    // (#15133): no greeting, no welcome-back, no reuse narration — a pure
    // reuse lands straight in chat, and only a real provision/wake narrates.
    // Otherwise the greeting offers the one sign-in button; its tap enters
    // the normal cloud pick path (the gesture the real login flow needs). A
    // cold relaunch just re-enters this branch, so no durable resume marker
    // is needed — any stale chooser-mode marker is dropped. The local-backup
    // restore probe is skipped: restoring a local agent is a chooser-mode
    // concept.
    if (flowMode === "cloud-only") {
      clearCloudLoginPending();
      draftRef.current = {
        ...draftRef.current,
        runtime: "cloud",
        localInference: "cloud-inference",
      };
      // The resume is armed in ALL branches: with a usable session it drives
      // the immediate provision; without one it lets a session that lands
      // later without a tap (login from another same-origin tab, an injected
      // hosted-web session) auto-continue via the auto-resume effect.
      pendingCloudResumeRef.current = "cloud";
      let tokenPoll: ReturnType<typeof setInterval> | null = null;
      let cancelled = false;
      const stopTokenPoll = () => {
        if (tokenPoll) clearInterval(tokenPoll);
        tokenPoll = null;
      };
      const resumeStoredToken = () => {
        if (isFirstRunFlowProvisioned(flowRef.current)) {
          stopTokenPoll();
          return;
        }
        if (isFirstRunFlowBusy(flowRef.current)) return;
        if (!hasUsableStoredStewardToken()) return;
        stopTokenPoll();
        seedTurn(makeTurn("first-run:cloud-signin", CLOUD_WELCOME_BACK));
        runCloudResumeRef.current("cloud");
      };
      const startTokenPoll = () => {
        if (tokenPoll) return;
        tokenPoll = setInterval(resumeStoredToken, 500);
      };
      // Degrade target shared by the no-session path and a failed cookie
      // recovery: the sign-in greeting plus a cheap localStorage poll. A
      // usable session can LAND after mount without any elizaCloudConnected
      // flip (the native storage bridge hydrates the durable token from
      // Capacitor Preferences asynchronously; a web login in another
      // same-origin tab writes it directly), so poll (one localStorage read
      // per tick) and upgrade to the welcome-back skip the moment it appears;
      // a pick already in flight always wins. The welcome-back turn stays on
      // THIS path only — a greeting was genuinely shown, so silently yanking
      // the conversation would read as broken.
      const seedSignInGreetingAndPoll = () => {
        flowRef.current = firstRunFlowPhase.signingIn();
        seedTurn(makeTurn("first-run:greeting", CLOUD_SIGN_IN_GREETING));
        seedTurn(makeTurn("first-run:cloud-oauth", CLOUD_SIGN_IN_CHOICE));
        startTokenPoll();
      };
      const onNativeResume = () => {
        if (cancelled) return;
        startTokenPoll();
        resumeStoredToken();
      };
      const onVisibilityChange = () => {
        if (typeof document !== "undefined" && document.hidden) return;
        onNativeResume();
      };
      document.addEventListener(APP_RESUME_EVENT, onNativeResume);
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (elizaCloudConnectedRef.current || hasUsableStoredStewardToken()) {
        runCloudResumeRef.current("cloud", "silent");
      } else if (typeof window !== "undefined" && hasStewardAuthedCookie()) {
        // Cross-subdomain SSO (#15089/#15133): a user already signed in on
        // the console carries the shared, HttpOnly .elizacloud.ai refresh
        // cookie, but localStorage does not cross subdomains — so this app
        // origin has no stored token yet. Seed NOTHING and recover the access
        // token first (same-origin refresh, bounded like
        // startup-phase-restore's resolveRestoredStewardToken) so an
        // authenticated user never sees a sign-in greeting that a
        // welcome-back then has to walk back — the "onboarding theater"
        // report. During the sub-second hold the already-painted shell shows
        // the empty first-run chat; a stale marker cookie costs at most the
        // 4s bound before the normal greeting appears. Web-only by
        // construction: native has no document cookie and carries the durable
        // token through the branch above.
        void (async () => {
          let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
          // error-policy:J4 a failed/timed-out cookie refresh degrades to the
          // normal sign-in greeting below; it never fabricates a session.
          const refreshed = await Promise.race([
            refreshCloudStewardSession().catch(() => null),
            new Promise<null>((resolve) => {
              refreshTimeout = setTimeout(
                () => resolve(null),
                FIRST_RUN_COOKIE_REFRESH_TIMEOUT_MS,
              );
            }),
          ]);
          if (refreshTimeout) clearTimeout(refreshTimeout);
          if (cancelled) return;
          if (refreshed?.token) {
            writeStoredStewardToken(refreshed.token);
            try {
              window.dispatchEvent(new CustomEvent("steward-token-sync"));
            } catch (error) {
              void error;
              // error-policy:J6 best-effort nudge — consumers re-read the
              // stored token on their next tick regardless.
            }
            runCloudResumeRef.current("cloud", "silent");
            return;
          }
          // A Cloud connection may have landed while cookie recovery was
          // waiting. Never let this late fallback downgrade an active
          // provisioning/error/completed phase and start a second flow.
          if (flowRef.current.kind !== "signing-in") return;
          seedSignInGreetingAndPoll();
        })();
      } else {
        seedSignInGreetingAndPoll();
      }
      return () => {
        cancelled = true;
        stopTokenPoll();
        document.removeEventListener(APP_RESUME_EVENT, onNativeResume);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        clearHandoffRecovery();
        setFirstRunActionHandler(null);
      };
    }
    // Cloud-login resume: if the app was cold-launched mid cloud OAuth (the
    // external browser evicted the WebView on a device), rehydrate the
    // interrupted cloud/hybrid flow instead of restarting at the greeting.
    // The durable steward token (persisted at login) makes elizaCloudConnected
    // recompute true after relaunch, so the auto-resume effect above completes
    // onboarding into chat. If login never finished, re-offer the same single
    // sign-in CTA instead of rendering a second in-chat Connect card.
    const cloudResume = readCloudLoginPending();
    if (cloudResume) {
      flowRef.current = firstRunFlowPhase.signingIn();
      draftRef.current = {
        ...draftRef.current,
        agentName: cloudResume.agentName || draftRef.current.agentName,
        runtime: cloudResume.runtime === "cloud" ? "cloud" : "local",
        localInference: cloudResume.localInference,
      };
      pendingCloudResumeRef.current = cloudResume.runtime;
      seedTurn(makeTurn("first-run:cloud-oauth", CLOUD_SIGN_IN_CHOICE));
      // If the durable token already made the connection live at launch, the
      // auto-resume effect above fired once before this marker was armed, so it
      // won't self-fire — resume now. Otherwise leave the marker armed for the
      // effect to catch when elizaCloudConnected flips true after the poll.
      if (elizaCloudConnectedRef.current) {
        runCloudResumeRef.current(cloudResume.runtime);
      }
    } else {
      // Seed the greeting + runtime choice IMMEDIATELY on mount — never gate it
      // on the agent-readiness probe below. `listLocalAgentBackups()` hits the
      // local agent API, which on a fresh/booting/wedged device can hang
      // indefinitely; coupling the greeting to it stranded the user at a locked
      // composer ("Tap a highlighted option above to continue") with no visible
      // choices. The backup probe is now a purely additive upgrade.
      seedRuntimeChoice();
    }
    let cancelled = false;
    void client
      .listLocalAgentBackups()
      .then((backups) => {
        if (!cancelled && backups.length > 0) seedBackupRestoreChoice(backups);
      })
      .catch((err: unknown) => {
        // error-policy:J4 the backup probe is a purely additive upgrade (see
        // above): on failure first-run proceeds without the restore choice.
        // Logged so a wedged local agent is diagnosable.
        logger.debug(
          { err },
          "[useFirstRunConductor] local-agent backup probe failed",
        );
      });
    return () => {
      cancelled = true;
      clearHandoffRecovery();
      setFirstRunActionHandler(null);
    };
  }, [
    active,
    clearHandoffRecovery,
    flowMode,
    seedBackupRestoreChoice,
    seedRuntimeChoice,
    seedTurn,
    setConversationMessages,
  ]);
}

/** Mount point — call once inside the AppContext provider tree. Renders null. */
export function FirstRunConductorMount(): null {
  useFirstRunConductor();
  return null;
}
