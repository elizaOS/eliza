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
import { useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { preOpenWindow } from "../utils";
import { normalizeFirstRunName } from "./first-run";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
} from "./first-run-action-channel";
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

// Onboarding stays a clean two-option location chooser: Cloud (managed) or
// On this device. "Bring your own keys" is NOT a location — it just ran the
// local backend and pre-highlighted the BYOK inference provider, so it lived on
// the wrong axis. BYOK stays fully reachable one step later via the provider
// sub-choice (provider:other → localInference "configure-later"). Remote agents
// + multi-instance management live in Settings → Runtime (post-#9952).
const RUNTIME_CHOICE = [
  "[CHOICE:first-run id=runtime]",
  `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)`,
  `${FIRST_RUN_ACTION_PREFIX}runtime:local=On this device`,
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
      latestLocalBackupRef.current = newestLocalBackup(backups);
      if (!latestLocalBackupRef.current) {
        seedRuntimeChoice();
        return;
      }
      seedTurn(
        makeTurn(
          "first-run:backup-restore",
          `${RESTORE_GREETING}\n\n${BACKUP_RESTORE_CHOICE}`,
        ),
      );
    },
    [seedRuntimeChoice, seedTurn],
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
      seedTurn(
        makeTurn(
          `first-run:error:${Date.now()}`,
          `${message}\n\n${RUNTIME_CHOICE}`,
        ),
      );
    },
    [seedTurn],
  );

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

  // Auto-resume: when the user connects Eliza Cloud from the retry turn's
  // OAuth block (instead of re-picking a runtime), continue the interrupted
  // flow the moment the store learns the connection landed. A fresh pick
  // clears the pending marker, so the user's latest intent always wins.
  React.useEffect(() => {
    if (!active || !elizaCloudConnected) return;
    const resume = pendingCloudResumeRef.current;
    if (!resume || busyRef.current || provisionedRef.current) return;
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
  }, [
    active,
    elizaCloudConnected,
    replaceTurn,
    startCloudProvisionFlow,
    startProviderFinish,
  ]);

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
      // Once provisioning succeeded only the tutorial pick is live; taps on
      // leftover runtime/provider/cloud-agent widgets must not re-provision.
      if (provisionedRef.current && group !== "tutorial") return true;
      // A fresh pick supersedes any armed connect-and-resume continuation.
      pendingCloudResumeRef.current = null;

      if (group === "runtime") {
        if (id !== "cloud" && id !== "local") return true;
        if (id === "cloud") {
          draftRef.current = {
            ...draftRef.current,
            runtime: "cloud",
            localInference: "cloud-inference",
          };
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
        // On this device: run the local backend, then ask which model provider.
        // BYOK is the provider:other sub-choice ("Other / configure in
        // Settings" → localInference "configure-later").
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
        if (id === "elizacloud") {
          draftRef.current = {
            ...draftRef.current,
            localInference: "cloud-inference",
          };
        } else if (id === "other") {
          // "Other / configure in Settings" (bring your own keys): run locally
          // but wire NO provider, so the finish path's `needsProviderSetup`
          // handoff surfaces the "Open Settings" banner where the user picks a
          // subscription provider (Anthropic / Codex / z.ai / Kimi). NOT
          // all-local — that would silently download an on-device model and
          // suppress the banner.
          draftRef.current = {
            ...draftRef.current,
            localInference: "configure-later",
          };
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
      seedError,
      startCloudProvisionFlow,
      startProviderFinish,
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
    let cancelled = false;
    void client
      .listLocalAgentBackups()
      .then((backups) => {
        if (cancelled) return;
        if (backups.length > 0) {
          seedBackupRestoreChoice(backups);
          return;
        }
        seedRuntimeChoice();
      })
      .catch(() => {
        if (!cancelled) seedRuntimeChoice();
      });
    return () => {
      cancelled = true;
      setFirstRunActionHandler(null);
    };
  }, [active, seedBackupRestoreChoice, seedRuntimeChoice]);
}

/** Mount point — call once inside the AppContext provider tree. Renders null. */
export function FirstRunConductorMount(): null {
  useFirstRunConductor();
  return null;
}
