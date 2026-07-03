// ============================================================================
// In-chat first-run conductor (headless).
//
// Onboarding is PART OF THE CHAT. When `firstRunComplete === false` this hook
// seeds synthetic assistant turns into the SAME live transcript the floating
// `ContinuousChatOverlay` renders (greeting → runtime CHOICE → Cloud OAuth via
// the message `secretRequest` field → provider CHOICE → tutorial CHOICE), and
// routes the user's first-run-scoped picks to the headless finish use case
// (`first-run-finish.ts`). It owns NO presentation — the existing
// `InlineWidgetText` + `SensitiveRequestBlock` renderers draw the widgets for
// free from message fields. It registers an action handler on the first-run
// channel so the chat's single send funnel short-circuits first-run picks
// before they hit the server.
//
// Provisioning runs exactly once and POSTs /api/first-run exactly once (the
// finish module funnels + idempotency-guards it). The real
// `firstRunComplete` flip is DEFERRED to the tutorial-or-skip pick, so the
// tutorial step is reachable after every runtime path.
//
// Confused-user guards (spam taps, stale widgets, out-of-order picks):
// - `busyRef` — one finish/provision flow at a time; extra picks are consumed
//   as no-ops while one is in flight.
// - `provisionedRef` latch — after provisioning succeeds only the tutorial
//   pick is live; leftover runtime/provider/cloud-agent widgets no-op.
// - Strict id validation per group — garbage under the reserved prefix is
//   consumed, never acted on and never forwarded to the server.
// - needs-cloud-login re-offers an UNLOCKED runtime choice and arms a
//   connect-and-resume continuation (`pendingCloudResumeRef`).
// ============================================================================

import * as React from "react";
import type {
  ConversationMessage,
  ConversationSecretRequest,
  LocalAgentBackupMetadata,
} from "../api";
import { client } from "../api";
import { getCloudAuthToken } from "../api/client-cloud";
import { startTutorial } from "../components/pages/tutorial/tutorial-controller";
import { getBootConfig } from "../config/boot-config";
import { ACCENT_PRESETS, useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { preOpenWindow } from "../utils";
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

const GREETING =
  "Hi — I'm Eliza. Let's get you set up. First, where should your agent run?";

/** User-facing recovery message when a cloud provisioning call rejects. */
function cloudFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : "";
  return detail
    ? `Couldn't connect to Eliza Cloud: ${detail}. Pick how to run your agent again.`
    : "Couldn't connect to Eliza Cloud. Pick how to run your agent again.";
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

// The first-run location chooser: Cloud (managed), On this device, or Remote
// (connect to an existing agent elsewhere). "Bring your own keys" is NOT a
// location — it lives one step later on the provider sub-choice as
// "Other / configure in Settings" (provider:other), which drops the user into
// the full Settings UI to wire their own provider by hand. Remote picks an
// already-running agent by URL + token; it owns its own provider, so it skips
// the provider sub-step.
const RUNTIME_CHOICE = [
  "[CHOICE:first-run id=runtime]",
  `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)`,
  `${FIRST_RUN_ACTION_PREFIX}runtime:local=On this device`,
  `${FIRST_RUN_ACTION_PREFIX}runtime:remote=Connect to a remote agent`,
  "[/CHOICE]",
].join("\n");

const BACKUP_RESTORE_CHOICE = [
  "[CHOICE:first-run id=backup-restore]",
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:latest=Restore latest backup`,
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:start-fresh=Start fresh`,
  "[/CHOICE]",
].join("\n");

function providerChoice(opts: { defaultId: "on-device" | "other" }): string {
  const onDevice = `${FIRST_RUN_ACTION_PREFIX}provider:on-device=On this device (recommended)`;
  const cloud = `${FIRST_RUN_ACTION_PREFIX}provider:elizacloud=Eliza Cloud inference`;
  const other = `${FIRST_RUN_ACTION_PREFIX}provider:other=Other / configure in Settings`;
  const ordered =
    opts.defaultId === "on-device"
      ? [onDevice, cloud, other]
      : [other, onDevice, cloud];
  return ["[CHOICE:first-run id=provider]", ...ordered, "[/CHOICE]"].join("\n");
}

const TUTORIAL_CHOICE = [
  "[CHOICE:first-run id=tutorial]",
  `${FIRST_RUN_ACTION_PREFIX}tutorial:start=Take the tutorial`,
  `${FIRST_RUN_ACTION_PREFIX}tutorial:skip=Skip for now`,
  "[/CHOICE]",
].join("\n");

// Recovery choice seeded when a finish/provision flow fails (e.g. a 404 from
// POST /api/first-run). It replaces the old "re-append the runtime question"
// behavior — which, on a persistent finish error, re-looped the runtime prompt
// forever with no explanation and no escape. Every option here is a real way
// forward: retry the same runtime, pick a different one, or bail out to Settings
// and configure a provider by hand.
const ERROR_CHOICE = [
  "[CHOICE:first-run id=error]",
  `${FIRST_RUN_ACTION_PREFIX}error:retry=Try again`,
  `${FIRST_RUN_ACTION_PREFIX}error:restart=Choose a different way to run`,
  `${FIRST_RUN_ACTION_PREFIX}error:settings=Configure in Settings`,
  "[/CHOICE]",
].join("\n");

/**
 * Turn a raw finish error into a human sentence. The underlying message can be
 * a terse transport string ("Not found" for a 404, "Failed to fetch", …) that
 * means nothing to a first-run user; lead with a clear framing and keep the raw
 * detail for context.
 */
function finishErrorMessage(message: string): string {
  const detail = message.trim();
  const isTerse = /^(not found|failed to fetch|forbidden|unauthorized)$/i.test(
    detail,
  );
  const lead = isTerse
    ? `I couldn't finish setting up your agent (${detail}).`
    : `I couldn't finish setting up your agent: ${detail}`;
  return `${lead}\n\nYou can try again, pick a different way to run your agent, or configure a model provider yourself in Settings.`;
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
function cloudOAuthSecretRequest(
  status: ConversationSecretRequest["status"],
): ConversationSecretRequest {
  return {
    key: "elizacloud",
    reason: "Connect your Eliza Cloud account",
    status,
    form: {
      type: "sensitive_request_form",
      kind: "oauth",
      mode: "cloud_authenticated_link",
      fields: [],
      submitLabel: "Connect Eliza Cloud",
      provider: "elizacloud",
      authorizationUrl: getBootConfig().cloudApiBase || "https://elizacloud.ai",
    },
  };
}

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
  seedTurn(turn: ConversationMessage): void;
  replaceTurn(id: string, next: ConversationMessage): void;
}

export function surfaceCloudLoginRetryTurn(writer: FirstRunTurnWriter): void {
  // Replacing the turn re-parses its CHOICE block, so the re-offered runtime
  // buttons arrive unlocked even when an earlier pick locked the originals —
  // without this the "pick again" instruction is a dead end (every prior
  // runtime widget locked itself on first tap).
  const connectTurn = makeTurn(
    "first-run:cloud-oauth",
    `Connect your Eliza Cloud account to continue — I'll pick up where we left off. You can also pick how to run your agent again.\n\n${RUNTIME_CHOICE}`,
    { secretRequest: cloudOAuthSecretRequest("failed") },
  );
  writer.seedTurn(connectTurn);
  writer.replaceTurn("first-run:cloud-oauth", connectTurn);
}

export function useFirstRunConductor(): void {
  const {
    firstRunComplete,
    firstRunName,
    completeFirstRun,
    elizaCloudConnected,
    handleCloudLogin,
    showActionBanner,
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
    showActionBanner: s.showActionBanner,
    setTab: s.setTab,
    setState: s.setState,
    setUiAccent: s.setUiAccent,
    uiLanguage: s.uiLanguage,
  }));
  const { setConversationMessages } = useConversationMessages();

  const active = firstRunComplete === false;

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
  const restoringBackupRef = React.useRef(false);
  // Set true once provisioning's completeFirstRun fired; the REAL store
  // completeFirstRun is deferred to the tutorial-or-skip pick.
  const provisionedRef = React.useRef(false);
  // True while a finish/provision call is in flight; every other first-run
  // pick is consumed as a no-op until it settles (see handleFirstRunAction).
  const busyRef = React.useRef(false);
  // Latched by the first tutorial pick: the store flip unregisters the handler
  // only on the next commit, so a double-tap could otherwise re-fire
  // completeFirstRun/startTutorial in the gap.
  const completedRef = React.useRef(false);

  // ── Transcript seam ──────────────────────────────────────────────────────
  const seedTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === turn.id) ? prev : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  const replaceTurn = React.useCallback(
    (id: string, next: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.map((m) => (m.id === id ? next : m)),
      );
    },
    [setConversationMessages],
  );
  // Seed a CHOICE turn that must arrive unlocked on every re-offer. A choice
  // widget locks itself after its first pick, and `seedTurn` dedups by id — so
  // re-offering into an existing turn would present a dead (locked) widget.
  // When the base turn already exists, seed a fresh retry turn instead.
  const seedFreshChoiceTurn = React.useCallback(
    (baseId: string, text: string) => {
      setConversationMessages((prev) => {
        if (!prev.some((m) => m.id === baseId)) {
          return [...prev, makeTurn(baseId, text)];
        }
        const retryId = `${baseId}:retry:${Date.now()}`;
        if (prev.some((m) => m.id === retryId)) return prev;
        return [...prev, makeTurn(retryId, text)];
      });
    },
    [setConversationMessages],
  );

  const seedTutorial = React.useCallback(() => {
    provisionedRef.current = true;
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
    seedTurn(
      makeTurn("first-run:greeting", `${GREETING}\n\n${RUNTIME_CHOICE}`),
    );
  }, [seedTurn]);

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
  // provisioning calls it, we record + offer the tutorial, and only flip the
  // real gate when the user picks a tutorial option.
  const ports = React.useMemo<FirstRunFinishPorts>(
    () => ({
      uiLanguage,
      elizaCloudConnected,
      handleCloudLogin,
      preOpenWindow,
      setRuntimeState: (key, value) => {
        setState(key, value as never);
      },
      showActionBanner,
      setTab,
      completeFirstRun: () => {
        seedTutorial();
      },
      onStatus: (text) => {
        if (text) {
          seedTurn(makeTurn(`first-run:status:${text}`, text));
        }
      },
    }),
    [
      uiLanguage,
      elizaCloudConnected,
      handleCloudLogin,
      setState,
      showActionBanner,
      setTab,
      seedTutorial,
      seedTurn,
    ],
  );
  const portsRef = React.useRef(ports);
  portsRef.current = ports;

  const seedError = React.useCallback(
    (message: string) => {
      // A DISTINCT, non-looping error surface. Previously this re-appended the
      // runtime CHOICE, so a persistent finish error (e.g. the /api/first-run
      // 404) re-offered the same runtime question forever with no way out. Now
      // the error turn carries its own recovery choice (retry / restart /
      // Settings escape) so onboarding is always recoverable.
      seedTurn(
        makeTurn(
          `first-run:error:${Date.now()}`,
          `${finishErrorMessage(message)}\n\n${ERROR_CHOICE}`,
        ),
      );
    },
    [seedTurn],
  );

  // Explicit, non-finish escape hatch out of onboarding: flip the real gate and
  // land the user in Settings so they can wire a model provider by hand. Used by
  // the provider "Other / configure in Settings" pick AND the error-recovery
  // "Configure in Settings" choice, so a broken finish never traps the user in
  // the loop. Latched by completedRef so a double-tap can't flip the gate twice.
  const exitToSettings = React.useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setTab("settings");
    completeFirstRun("settings");
  }, [setTab, completeFirstRun]);

  const seedCloudAgentChoice = React.useCallback(
    (agents: { id?: string; name?: string }[]) => {
      const lines = agents
        .filter((a): a is { id: string; name?: string } => Boolean(a.id))
        .map(
          (a) =>
            `${FIRST_RUN_ACTION_PREFIX}cloud-agent:${a.id}=${a.name?.trim() || a.id}`,
        );
      lines.push(
        `${FIRST_RUN_ACTION_PREFIX}cloud-agent:new=Create a new agent`,
      );
      seedFreshChoiceTurn(
        "first-run:cloud-agent",
        `Which Eliza Cloud agent should I use?\n\n[CHOICE:first-run id=cloud-agent]\n${lines.join("\n")}\n[/CHOICE]`,
      );
    },
    [seedFreshChoiceTurn],
  );

  // Armed by a needs-cloud-login outcome; consumed by the auto-resume effect
  // when the cloud connection lands (or cleared by the user's next pick).
  const pendingCloudResumeRef = React.useRef<"cloud" | "hybrid" | null>(null);

  const handleOutcome = React.useCallback(
    (outcome: FirstRunFinishOutcome) => {
      switch (outcome.kind) {
        case "done":
          // provisioning's completeFirstRun port already seeded the tutorial.
          if (!provisionedRef.current) seedTutorial();
          return;
        case "pick-cloud-agent":
          seedCloudAgentChoice(
            outcome.agents.map((a) => ({ id: a.agent_id, name: a.agent_name })),
          );
          return;
        case "needs-cloud-login": {
          pendingCloudResumeRef.current =
            draftRef.current.runtime === "cloud" ? "cloud" : "hybrid";
          surfaceCloudLoginRetryTurn({ seedTurn, replaceTurn });
          return;
        }
        case "error":
          seedError(outcome.message);
          return;
      }
    },
    [seedTutorial, seedCloudAgentChoice, seedTurn, replaceTurn, seedError],
  );

  // ── Flow launchers (shared by the action handler + the auto-resume) ──────
  const startCloudProvisionFlow = React.useCallback(() => {
    busyRef.current = true;
    void listOrAutoProvisionCloudAgent(draftRef.current, portsRef.current)
      .then((outcome) => {
        if (outcome.kind === "done" || outcome.kind === "pick-cloud-agent") {
          // Login resolved + provisioning is proceeding — the resume marker has
          // served its purpose; drop it so a later relaunch doesn't re-resume.
          clearCloudLoginPending();
          replaceTurn(
            "first-run:cloud-oauth",
            makeTurn("first-run:cloud-oauth", "Eliza Cloud connected.", {
              secretRequest: cloudOAuthSecretRequest("saved"),
            }),
          );
        }
        handleOutcome(outcome);
      })
      // Unlike runFirstRunFinish (which funnels throws to seedError), these
      // cloud entrypoints can reject (OAuth/network); without this the
      // "Connecting…" turn strands on screen as an unhandled rejection.
      .catch((err: unknown) => seedError(cloudFailureMessage(err)))
      .finally(() => {
        busyRef.current = false;
      });
  }, [handleOutcome, replaceTurn, seedError]);

  const startProviderFinish = React.useCallback(() => {
    busyRef.current = true;
    void runFirstRunFinish(draftRef.current, portsRef.current)
      .then(handleOutcome)
      .finally(() => {
        busyRef.current = false;
      });
  }, [handleOutcome]);

  // Continue an interrupted cloud/hybrid flow once the connection is present.
  // Shared by (a) the auto-resume effect below — used when the user connects
  // from the retry turn's OAuth block and the store later learns the connection
  // landed — and (b) the mount-time cloud-login rehydrate, which calls this
  // directly when the durable token already made the connection live at launch
  // (the effect fired once before the marker was armed, so it can't self-fire).
  const runCloudResume = React.useCallback(
    (resume: "cloud" | "hybrid") => {
      if (busyRef.current || provisionedRef.current) return;
      pendingCloudResumeRef.current = null;
      if (resume === "cloud") {
        replaceTurn(
          "first-run:cloud-oauth",
          makeTurn(
            "first-run:cloud-oauth",
            "Connecting your Eliza Cloud account…",
            { secretRequest: cloudOAuthSecretRequest("pending") },
          ),
        );
        startCloudProvisionFlow();
        return;
      }
      startProviderFinish();
    },
    [replaceTurn, startCloudProvisionFlow, startProviderFinish],
  );

  // Auto-resume: when the user connects Eliza Cloud from the retry turn's
  // OAuth block (instead of re-picking a runtime), continue the interrupted
  // flow the moment the store learns the connection landed. A fresh pick
  // clears the pending marker, so the user's latest intent always wins.
  React.useEffect(() => {
    if (!active || !elizaCloudConnected) return;
    const resume = pendingCloudResumeRef.current;
    if (!resume) return;
    runCloudResume(resume);
  }, [active, elizaCloudConnected, runCloudResume]);

  // Read-only mirrors so the mount effect can resume immediately when the
  // durable token already made the connection live at launch — without adding
  // elizaCloudConnected/runCloudResume to the mount effect's deps (which would
  // re-register the action handler and re-seed on every connection change).
  const elizaCloudConnectedRef = React.useRef(elizaCloudConnected);
  elizaCloudConnectedRef.current = elizaCloudConnected;
  const runCloudResumeRef = React.useRef(runCloudResume);
  runCloudResumeRef.current = runCloudResume;

  const handleFirstRunAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) return false;
      const suffix = value.slice(FIRST_RUN_ACTION_PREFIX.length);
      const separator = suffix.indexOf(":");
      const group = separator === -1 ? suffix : suffix.slice(0, separator);
      const id = separator === -1 ? "" : suffix.slice(separator + 1);

      // One provisioning flow at a time. Stale widgets survive in the
      // transcript (error re-seeds, the cloud-agent picker next to a re-offered
      // runtime choice), so a confused user can tap a second option while a
      // finish call is still in flight — consume those as no-ops instead of
      // starting a concurrent flow.
      if (busyRef.current) return true;
      // Once provisioning succeeded only the wrap-up picks (accent + tutorial)
      // are live; taps on leftover runtime/provider/cloud-agent widgets must not
      // re-provision.
      if (
        provisionedRef.current &&
        group !== "tutorial" &&
        group !== "accent"
      ) {
        return true;
      }
      // A fresh pick supersedes any armed connect-and-resume continuation —
      // including the durable cloud-resume marker (the cloud/hybrid branches
      // below re-arm it if the new pick is a cloud one).
      pendingCloudResumeRef.current = null;
      clearCloudLoginPending();

      if (group === "runtime") {
        if (id !== "cloud" && id !== "local" && id !== "remote") return true;
        if (id === "cloud") {
          draftRef.current = {
            ...draftRef.current,
            runtime: "cloud",
            localInference: "cloud-inference",
          };
          // Persist a resume marker BEFORE the (device) external-browser OAuth
          // backgrounds/evicts the WebView, so a cold-launch on return
          // rehydrates this cloud flow instead of restarting at the greeting.
          markCloudLoginPending({
            runtime: "cloud",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
          const connecting = makeTurn(
            "first-run:cloud-oauth",
            "Connecting your Eliza Cloud account…",
            { secretRequest: cloudOAuthSecretRequest("pending") },
          );
          seedTurn(connecting);
          replaceTurn("first-run:cloud-oauth", connecting);
          startCloudProvisionFlow();
          return true;
        }
        if (id === "remote") {
          // Remote: point at an already-running agent. Seed the inline URL +
          // token form; its `remote_connect` submit dispatches CONNECT_EVENT,
          // and the App handler connects + adopts the remote as the active
          // runtime + flips firstRunComplete (finishing onboarding). Remote owns
          // its own provider, so there is no provider sub-step — and it never
          // routes through runFirstRunFinish, so draftRef (a FirstRunFinishDraft,
          // which excludes "remote") is intentionally left untouched.
          const connect = makeTurn(
            "first-run:remote-connect",
            "Enter your remote agent's URL and access token to connect.",
            { secretRequest: remoteConnectSecretRequest() },
          );
          seedTurn(connect);
          replaceTurn("first-run:remote-connect", connect);
          return true;
        }
        // On this device: run the local backend, then ask which model provider.
        // BYOK is the provider:other sub-choice ("Other / configure in
        // Settings"), which opens Settings and exits first-run.
        draftRef.current = {
          ...draftRef.current,
          runtime: "local",
          localInference: "all-local",
        };
        seedFreshChoiceTurn(
          "first-run:provider",
          `Which model provider should ${draftRef.current.agentName} use?\n\n${providerChoice({ defaultId: "on-device" })}`,
        );
        return true;
      }

      if (group === "backup-restore") {
        if (id !== "latest" && id !== "start-fresh") return true;
        if (id === "start-fresh") {
          latestLocalBackupRef.current = null;
          seedRuntimeChoice();
          return true;
        }

        if (id === "latest") {
          const backup = latestLocalBackupRef.current;
          if (!backup || restoringBackupRef.current) return true;
          restoringBackupRef.current = true;
          seedTurn(
            makeTurn(
              "first-run:backup-restore-status",
              "Restoring the latest local backup...",
            ),
          );
          void client
            .restoreLocalAgentBackup(backup.fileName)
            .then(() => {
              seedTurn(
                makeTurn(
                  "first-run:backup-restore-complete",
                  "Backup restored. Restart the agent to use the restored state.",
                ),
              );
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              seedTurn(
                makeTurn(
                  `first-run:backup-restore-error:${Date.now()}`,
                  `Restore failed: ${message}\n\n${BACKUP_RESTORE_CHOICE}`,
                ),
              );
            })
            .finally(() => {
              restoringBackupRef.current = false;
            });
          return true;
        }
      }

      if (group === "provider") {
        if (id !== "on-device" && id !== "elizacloud" && id !== "other") {
          return true;
        }
        if (id === "other") {
          // "Other / configure in Settings" (bring your own keys): the user
          // wants the full Settings UI to wire their own provider (Anthropic /
          // Codex / z.ai / Kimi, …). Take them straight there and exit first-run
          // instead of running a finish flow — the old path ran a local finish
          // that, when it failed (e.g. the /api/first-run 404), re-looped the
          // onboarding questions instead of ever reaching Settings.
          exitToSettings();
          return true;
        }
        if (id === "elizacloud") {
          draftRef.current = {
            ...draftRef.current,
            localInference: "cloud-inference",
          };
          // Hybrid (local runtime + Cloud inference) also opens the external
          // OAuth browser — persist a resume marker so a WebView eviction on
          // return rehydrates the hybrid finish rather than restarting.
          markCloudLoginPending({
            runtime: "hybrid",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
        } else {
          // on-device: run every model locally (kicks off the download now).
          draftRef.current = {
            ...draftRef.current,
            localInference: "all-local",
          };
        }
        startProviderFinish();
        return true;
      }

      if (group === "cloud-agent") {
        if (!id) return true;
        const authToken = getCloudAuthToken(client) ?? "";
        if (!authToken) {
          handleOutcome({ kind: "needs-cloud-login" });
          return true;
        }
        cloudPrefsRef.current =
          id === "new" ? { forceCreate: true } : { preferAgentId: id };
        busyRef.current = true;
        void bindCloudAgent(
          draftRef.current,
          authToken,
          cloudPrefsRef.current,
          portsRef.current,
        )
          .then(handleOutcome)
          .catch((err: unknown) => seedError(cloudFailureMessage(err)))
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      if (group === "error") {
        if (id !== "retry" && id !== "restart" && id !== "settings") {
          return true;
        }
        if (id === "settings") {
          exitToSettings();
          return true;
        }
        if (id === "restart") {
          // Re-offer a FRESH (unlocked) runtime choice so the user can switch
          // how their agent runs after a failed finish. seedFreshChoiceTurn
          // seeds a retry turn when the greeting already exists (the original
          // runtime widget locked itself on its first pick).
          seedFreshChoiceTurn(
            "first-run:greeting",
            `${GREETING}\n\n${RUNTIME_CHOICE}`,
          );
          return true;
        }
        // retry: re-run the SAME finish for the runtime the user last chose.
        // The persist guard released itself on the failed POST, so a local
        // retry re-POSTs; a cloud retry re-runs provisioning.
        if (draftRef.current.runtime === "cloud") {
          const connecting = makeTurn(
            "first-run:cloud-oauth",
            "Connecting your Eliza Cloud account…",
            { secretRequest: cloudOAuthSecretRequest("pending") },
          );
          seedTurn(connecting);
          replaceTurn("first-run:cloud-oauth", connecting);
          startCloudProvisionFlow();
          return true;
        }
        startProviderFinish();
        return true;
      }

      if (group === "accent") {
        // "Make it yours": apply + persist the chosen accent live. Non-blocking
        // — the tutorial CHOICE seeded alongside still finishes onboarding, so
        // this never gates completion. Garbage ids are consumed as no-ops.
        if (!ACCENT_PRESETS.some((p) => p.id === id)) return true;
        setUiAccent(id);
        return true;
      }

      if (group === "tutorial") {
        if (id !== "start" && id !== "skip") return true;
        if (completedRef.current) return true;
        completedRef.current = true;
        // The single real completion: flip the gate (deactivates the conductor),
        // then optionally launch the interactive tutorial.
        completeFirstRun("chat");
        if (id === "start") startTutorial();
        return true;
      }

      // Unknown group under the reserved prefix: consume it (the value is
      // never a real chat message) and do nothing.
      return true;
    },
    [
      seedTurn,
      seedFreshChoiceTurn,
      seedRuntimeChoice,
      replaceTurn,
      handleOutcome,
      completeFirstRun,
      exitToSettings,
      seedError,
      startCloudProvisionFlow,
      startProviderFinish,
      setUiAccent,
    ],
  );
  const handleActionRef = React.useRef(handleFirstRunAction);
  handleActionRef.current = handleFirstRunAction;

  // Register the interceptor + seed the greeting while onboarding is active.
  React.useEffect(() => {
    if (!active) {
      setFirstRunActionHandler(null);
      return;
    }
    resetFirstRunPersistGuard();
    setFirstRunActionHandler((value) => handleActionRef.current(value));
    // Cloud-login resume: if the app was cold-launched mid cloud OAuth (the
    // external browser evicted the WebView on a device), rehydrate the
    // interrupted cloud/hybrid flow instead of restarting at the greeting.
    // The durable steward token (persisted at login) makes elizaCloudConnected
    // recompute true after relaunch, so the auto-resume effect above completes
    // onboarding into chat; the re-tappable OAuth turn below is the fallback if
    // login never finished — either way the user is never bounced back to
    // "where should your agent run?".
    const cloudResume = readCloudLoginPending();
    if (cloudResume) {
      draftRef.current = {
        ...draftRef.current,
        agentName: cloudResume.agentName || draftRef.current.agentName,
        runtime: cloudResume.runtime === "cloud" ? "cloud" : "local",
        localInference: cloudResume.localInference,
      };
      pendingCloudResumeRef.current = cloudResume.runtime;
      seedTurn(
        makeTurn(
          "first-run:cloud-oauth",
          "Connecting your Eliza Cloud account…",
          { secretRequest: cloudOAuthSecretRequest("pending") },
        ),
      );
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
      .catch(() => {});
    return () => {
      cancelled = true;
      setFirstRunActionHandler(null);
    };
  }, [active, seedBackupRestoreChoice, seedRuntimeChoice, seedTurn]);
}

/** Mount point — call once inside the AppContext provider tree. Renders null. */
export function FirstRunConductorMount(): null {
  useFirstRunConductor();
  return null;
}
