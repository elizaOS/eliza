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
import { type FirstRunProfileDraft, normalizeFirstRunName } from "./first-run";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
} from "./first-run-action-channel";
import {
  bindCloudAgent,
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

const RUNTIME_CHOICE = [
  "[CHOICE:first-run id=runtime]",
  `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)`,
  `${FIRST_RUN_ACTION_PREFIX}runtime:local=On this device`,
  `${FIRST_RUN_ACTION_PREFIX}runtime:other=Bring your own keys`,
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
      authorizationUrl:
        getBootConfig().cloudApiBase || "https://www.elizacloud.ai",
    },
  };
}

interface FirstRunTurnWriter {
  seedTurn(turn: ConversationMessage): void;
  replaceTurn(id: string, next: ConversationMessage): void;
}

export function surfaceCloudLoginRetryTurn(writer: FirstRunTurnWriter): void {
  const connectTurn = makeTurn(
    "first-run:cloud-oauth",
    "Connect your Eliza Cloud account to continue, then pick Eliza Cloud again.",
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
    switchAgentProfile,
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
    switchAgentProfile: s.switchAgentProfile,
    setState: s.setState,
    uiLanguage: s.uiLanguage,
  }));
  const { setConversationMessages } = useConversationMessages();

  const active = firstRunComplete === false;

  const draftRef = React.useRef<FirstRunProfileDraft>({
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
      switchAgentProfile,
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
      switchAgentProfile,
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
          `${message}\n\n[CHOICE:first-run id=runtime]\n${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)\n${FIRST_RUN_ACTION_PREFIX}runtime:local=On this device\n${FIRST_RUN_ACTION_PREFIX}runtime:other=Bring your own keys\n[/CHOICE]`,
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
      seedTurn(
        makeTurn(
          "first-run:cloud-agent",
          `Which Eliza Cloud agent should I use?\n\n[CHOICE:first-run id=cloud-agent]\n${lines.join("\n")}\n[/CHOICE]`,
        ),
      );
    },
    [seedTurn],
  );

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

  const handleFirstRunAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) return false;
      const suffix = value.slice(FIRST_RUN_ACTION_PREFIX.length);
      const [group, id] = suffix.split(":");

      if (group === "runtime") {
        if (id === "cloud") {
          draftRef.current = {
            ...draftRef.current,
            runtime: "cloud",
            localInference: "cloud-inference",
          };
          seedTurn(
            makeTurn(
              "first-run:cloud-oauth",
              "Connecting your Eliza Cloud account…",
              { secretRequest: cloudOAuthSecretRequest("pending") },
            ),
          );
          void listOrAutoProvisionCloudAgent(draftRef.current, portsRef.current)
            .then((outcome) => {
              if (
                outcome.kind === "done" ||
                outcome.kind === "pick-cloud-agent"
              ) {
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
            .catch((err: unknown) => seedError(cloudFailureMessage(err)));
          return true;
        }
        // local + "other" (bring your own keys) both run the local backend;
        // they differ only in the provider default the choice pre-highlights.
        draftRef.current = {
          ...draftRef.current,
          runtime: "local",
          localInference: "all-local",
        };
        seedTurn(
          makeTurn(
            "first-run:provider",
            `Which model provider should ${draftRef.current.agentName} use?\n\n${providerChoice({ defaultId: id === "other" ? "other" : "on-device" })}`,
          ),
        );
        return true;
      }

      if (group === "backup-restore") {
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
        void runFirstRunFinish(draftRef.current, portsRef.current).then(
          handleOutcome,
        );
        return true;
      }

      if (group === "cloud-agent") {
        const authToken = getCloudAuthToken(client) ?? "";
        if (!authToken) {
          handleOutcome({ kind: "needs-cloud-login" });
          return true;
        }
        cloudPrefsRef.current =
          id === "new" ? { forceCreate: true } : { preferAgentId: id };
        void bindCloudAgent(
          draftRef.current,
          authToken,
          cloudPrefsRef.current,
          portsRef.current,
        )
          .then(handleOutcome)
          .catch((err: unknown) => seedError(cloudFailureMessage(err)));
        return true;
      }

      if (group === "tutorial") {
        // The single real completion: flip the gate (deactivates the conductor),
        // then optionally launch the interactive tutorial.
        completeFirstRun("chat");
        if (id === "start") startTutorial();
        return true;
      }

      return false;
    },
    [
      seedTurn,
      seedRuntimeChoice,
      replaceTurn,
      handleOutcome,
      completeFirstRun,
      seedError,
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
