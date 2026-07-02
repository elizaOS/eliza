/**
 * CockpitSessionPane — the coding cockpit's drill-in surface (Step 2 of the
 * gap-fill plan).
 *
 * Tapping a room on the deck drills into THIS single-room detail view. It is a
 * pure composition of pieces that already exist in the orchestrator workbench,
 * lifted out of the 3.9k-line monolith so the cockpit can embed one room without
 * the list+filter chrome:
 *
 *   • {@link useOrchestratorData} — the live data layer (detail + timeline,
 *     fast-poll while active, SSE near-live, loud-failure mutations).
 *   • {@link buildConversation} + {@link ConversationBlockView} — the flowing
 *     Claude-Code/Codex-style transcript (user/agent turns, tool cards with
 *     diffs, reasoning cells, notices).
 *   • {@link TaskInspector} — the full action bar (pause/resume/archive/fork/
 *     restart/validate/add-agent/stop-agent/…), wired to the same client calls
 *     the workbench uses, with `setSelectedId(null)` swapped for `onBack()`.
 *
 * It also unifies the drill-in with the floating-composer bubble binding (Step
 * 1): while this pane is open it registers a {@link useRegisterViewChatBinding}
 * `onSubmit` that routes the composer's text to THIS task's room via
 * `postOrchestratorTaskMessage`, so the one bubble drives the focused room.
 *
 * The parent (CockpitRoute) owns selection — it renders this pane for a chosen
 * taskId and passes `onBack` to return to the deck.
 */

import {
  CockpitTierToggle,
  type CodingAgentSession,
  client,
  ELIZA_CLOUD_TIER_MODEL,
  type ElizaCloudTier,
  useRegisterViewChatBinding,
} from "@elizaos/ui";
import {
  ArrowLeft,
  PanelRight,
  ScrollText,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CockpitTerminalPanel } from "./CockpitTerminalPanel";
import {
  HIDDEN_STYLE,
  INSPECTOR_DRAWER_STYLE,
  TaskInspector,
  useIsMobile,
} from "./OrchestratorWorkbench";
import { ConversationBlockView } from "./orchestrator-stream";
import { buildConversation } from "./orchestrator-stream.helpers";
import {
  fallbackTranslate,
  resolveSenderName,
  type StatusFilter,
  type Translate,
} from "./orchestrator-workbench-glyphs";
import { useOrchestratorData } from "./use-orchestrator-data";

export interface CockpitSessionPaneProps {
  /** The task room to drill into. */
  taskId: string;
  /** Return to the deck (the parent clears its selection). */
  onBack: () => void;
  /** Translator; defaults to English `defaultValue`s (the cockpit is not yet
   * threaded with the app `t` — see the i18n step). */
  t?: Translate;
  /** BCP-47 locale for clock/number formatting in the transcript. */
  locale?: string;
}

export function CockpitSessionPane({
  taskId,
  onBack,
  t = fallbackTranslate,
  locale,
}: CockpitSessionPaneProps) {
  const { detail, messages, events, mutating, actionError, runMutation } =
    useOrchestratorData({
      selectedId: taskId,
      showArchived: false,
      statusFilter: "all" as StatusFilter,
      deferredSearch: "",
      t,
    });

  // The add-agent form is controlled state owned here (mirrors the workbench),
  // so the inspector's "Add agent" affordance works end to end.
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  // CLI face: "transcript" (pretty) ⇄ "terminal" (a read-mostly PTY-output WATCH
  // view — ACP sessions run --no-terminal, so it's not an interactive shell
  // until a PTY_SERVICE-backed build exists; see CockpitTerminalPanel).
  const [view, setView] = useState<"transcript" | "terminal">("transcript");

  // On a phone the TaskInspector's default 320px side rail would crush the
  // transcript/terminal to a few unreadable pixels with no way to dismiss it.
  // Mirror the OrchestratorWorkbench treatment of the same component: a
  // JS-driven (matchMedia, not `md:` — the view bundle ships no CSS) dismissible
  // slide-over toggled by a Details button. Desktop keeps the side rail.
  const isMobile = useIsMobile();
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // The PTY session feed (CodingAgentSession[]) is a separate source from the
  // task detail; poll it and narrow to THIS task's sessions by matching
  // sessionId against the task's session records.
  const [ptySessions, setPtySessions] = useState<CodingAgentSession[]>([]);
  const ptyPollFailedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const status = await client.getCodingAgentStatus();
        if (!alive) return;
        setPtySessions(status?.tasks ?? []);
        ptyPollFailedRef.current = false;
      } catch (e) {
        // Don't silently swallow a persistently-broken status endpoint (Shaw's
        // review): warn once per failure streak (not every 3s), and the terminal
        // shows its empty state meanwhile.
        if (!ptyPollFailedRef.current) {
          ptyPollFailedRef.current = true;
          console.warn(
            "[cockpit] coding-agent status poll failed; terminal sessions unavailable",
            e,
          );
        }
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 3_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const taskSessionIds = useMemo(
    () =>
      new Set(
        (detail?.sessions ?? [])
          .map((s) => s.sessionId)
          .filter((id): id is string => Boolean(id)),
      ),
    [detail?.sessions],
  );
  const terminalSessions = useMemo(
    () => ptySessions.filter((s) => taskSessionIds.has(s.sessionId)),
    [ptySessions, taskSessionIds],
  );
  const activeSessionId = useMemo(() => {
    const live = terminalSessions.find(
      (s) => s.status === "active" || s.status === "tool_running",
    );
    return live?.sessionId ?? terminalSessions[0]?.sessionId ?? null;
  }, [terminalSessions]);

  // Eliza Cloud sessions can hot-swap Fast/Smart tier (persist policy + respawn;
  // see CockpitTierToggle — there is no in-place ACP model swap).
  const isElizaCloud =
    detail?.providerPolicy?.preferredFramework === "elizaos" &&
    detail?.providerPolicy?.providerSource === "eliza-cloud";
  // While both tiers lower to the SAME model, flipping the toggle would persist
  // an identical policy and then restart({stopActive:true}) — killing the live
  // worker mid-task for zero effect. Hide the toggle until the tiers diverge.
  const tiersDiverge =
    ELIZA_CLOUD_TIER_MODEL.small !== ELIZA_CLOUD_TIER_MODEL.large;
  const currentTier: ElizaCloudTier = !tiersDiverge
    ? "small"
    : detail?.providerPolicy?.model === ELIZA_CLOUD_TIER_MODEL.large
      ? "large"
      : "small";
  const onTierChange = useCallback(
    (tier: ElizaCloudTier) => {
      const model = ELIZA_CLOUD_TIER_MODEL[tier];
      void runMutation(async () => {
        await client.updateOrchestratorTask(taskId, {
          providerPolicy: {
            preferredFramework: "elizaos",
            providerSource: "eliza-cloud",
            model,
          },
        });
        // RESTART (stopActive) rather than add-agent: restartTask stops the
        // worker(s) running on the OLD model, then respawns a single fresh one
        // from the just-updated providerPolicy. Adding a worker would accumulate
        // live agents on the task with each tier flip (Shaw's review of #10544).
        await client.restartOrchestratorTask(taskId, { stopActive: true });
      });
    },
    [taskId, runMutation],
  );

  // Sub-agents render their per-session label; derive the lookup exactly as the
  // workbench does (OrchestratorWorkbench.tsx).
  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of detail?.sessions ?? []) {
      const label = session.label?.trim();
      if (session.sessionId && label) map.set(session.sessionId, label);
    }
    return map;
  }, [detail?.sessions]);

  const finishedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of detail?.sessions ?? []) {
      if (
        session.sessionId &&
        (session.stoppedAt != null || session.status === "completed")
      ) {
        ids.add(session.sessionId);
      }
    }
    return ids;
  }, [detail?.sessions]);

  // The orchestrator's display name comes from the app store in the workbench
  // (`agentStatus.agentName`); an embeddable pane has no store access, so pass
  // `undefined` — resolveSenderName falls back to the generic "Orchestrator"
  // role label, while sub-agents still render their own session labels.
  const conversation = useMemo(
    () =>
      buildConversation(
        messages,
        events,
        (message) => resolveSenderName(message, sessionLabelById, undefined, t),
        finishedSessionIds,
      ),
    [messages, events, sessionLabelById, finishedSessionIds, t],
  );

  // Claim the floating composer's SEND while this pane is open: route it to THIS
  // task's room. Stable identity (only `taskId` matters) so the binding does not
  // needlessly re-register on every transcript tick.
  const [composerError, setComposerError] = useState<string | null>(null);
  const onComposerSubmit = useCallback(
    (text: string): boolean => {
      setComposerError(null);
      // Surface a delivery failure: the composer has already cleared by the time
      // this resolves, so a silently-dropped post would lose the user's message
      // (Shaw's review of #10544). Still return true — the send WAS claimed.
      client.postOrchestratorTaskMessage(taskId, text).catch((e: unknown) => {
        setComposerError(
          e instanceof Error
            ? `Couldn't deliver your message: ${e.message}`
            : "Couldn't deliver your message.",
        );
      });
      return true;
    },
    [taskId],
  );
  useRegisterViewChatBinding({
    placeholder: t("cockpit.session.composer", {
      defaultValue: `Message ${detail?.title ?? "agent"}`,
    }),
    onSubmit: onComposerSubmit,
  });

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-bg"
      data-testid="cockpit-session-pane"
    >
      <header className="flex shrink-0 items-center gap-2 border-border/40 border-b px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-hover/40 hover:text-txt"
          aria-label={t("cockpit.session.back", {
            defaultValue: "Back to all rooms",
          })}
          data-testid="cockpit-session-back"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
          {detail?.title ??
            t("cockpit.session.loading", { defaultValue: "Loading room…" })}
        </h2>
        {isElizaCloud && tiersDiverge ? (
          <CockpitTierToggle
            value={currentTier}
            onChange={onTierChange}
            disabled={mutating}
            className="shrink-0"
          />
        ) : null}
        <fieldset
          className="flex shrink-0 items-center gap-1 border-0 p-0"
          aria-label={t("cockpit.session.viewMode", {
            defaultValue: "View mode",
          })}
        >
          <button
            type="button"
            onClick={() => setView("transcript")}
            aria-pressed={view === "transcript"}
            data-testid="cockpit-view-transcript"
            title={t("cockpit.session.transcript", {
              defaultValue: "Transcript",
            })}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              view === "transcript"
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-bg-hover/40 hover:text-txt"
            }`}
          >
            <ScrollText className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setView("terminal")}
            aria-pressed={view === "terminal"}
            data-testid="cockpit-view-terminal"
            title={t("cockpit.session.watch", {
              defaultValue: "Watch (terminal output)",
            })}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              view === "terminal"
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-bg-hover/40 hover:text-txt"
            }`}
          >
            <SquareTerminal className="h-4 w-4" aria-hidden />
          </button>
        </fieldset>
        {isMobile && detail ? (
          <button
            type="button"
            onClick={() => setInspectorOpen((prev) => !prev)}
            aria-pressed={inspectorOpen}
            data-testid="cockpit-session-details-toggle"
            title={t("cockpit.session.details", { defaultValue: "Details" })}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
              inspectorOpen
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-bg-hover/40 hover:text-txt"
            }`}
          >
            <PanelRight className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </header>

      {composerError ? (
        <div
          role="alert"
          data-testid="cockpit-session-error"
          className="shrink-0 border-destructive/40 border-b bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {composerError}
        </div>
      ) : null}

      {/* Inspector-action failures (pause/resume/archive/delete/fork/restart/
          validate/add-agent/stop-agent/tier-flip): useOrchestratorData's
          runMutation catches instead of rethrowing and surfaces the message as
          `actionError` — without this banner every failed action is silent. */}
      {actionError ? (
        <div
          role="alert"
          data-testid="cockpit-session-action-error"
          className="shrink-0 border-destructive/40 border-b bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {view === "terminal" ? (
          <div
            className="min-w-0 flex-1 overflow-hidden p-2"
            data-testid="cockpit-session-terminal"
          >
            <CockpitTerminalPanel
              activeSessionId={activeSessionId}
              sessions={terminalSessions}
            />
          </div>
        ) : (
          <div
            className="min-w-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
            data-testid="cockpit-session-transcript"
          >
            {conversation.length === 0 ? (
              <p className="px-1 text-xs text-muted">
                {t("cockpit.session.empty", {
                  defaultValue: "No messages yet.",
                })}
              </p>
            ) : (
              conversation.map((block) => (
                <ConversationBlockView
                  key={block.key}
                  block={block}
                  locale={locale}
                />
              ))
            )}
          </div>
        )}

        {detail ? (
          <TaskInspector
            detail={detail}
            // Override the class only for the mobile drawer: an unconditional
            // "flex" suppressed TaskInspector's `flex w-80` fallback, and in
            // this flex ROW the shrink-0 inspector inflated to max-content on
            // desktop, crushing the transcript.
            className={isMobile ? "flex" : undefined}
            style={
              isMobile
                ? inspectorOpen
                  ? INSPECTOR_DRAWER_STYLE
                  : HIDDEN_STYLE
                : undefined
            }
            onClose={isMobile ? () => setInspectorOpen(false) : undefined}
            busy={mutating}
            addAgentOpen={addAgentOpen}
            onPause={() =>
              runMutation(() => client.pauseOrchestratorTask(taskId))
            }
            onResume={() =>
              runMutation(() => client.resumeOrchestratorTask(taskId))
            }
            onArchive={() =>
              runMutation(async () => {
                await client.archiveCodingAgentTaskThread(taskId);
                onBack();
              })
            }
            onReopen={() =>
              runMutation(() => client.reopenCodingAgentTaskThread(taskId))
            }
            onDelete={() =>
              runMutation(async () => {
                await client.deleteOrchestratorTask(taskId);
                onBack();
              })
            }
            onFork={() =>
              // Fork creates a new task; navigating TO it is a parent (selection)
              // concern the pane has no handle on, so v1 forks and stays put —
              // the new room surfaces on the deck when the user goes back.
              runMutation(() => client.forkOrchestratorTask(taskId))
            }
            onRestart={() => {
              const confirmed =
                typeof window === "undefined" ||
                window.confirm(
                  t("orchestrator.confirmRestart", {
                    defaultValue:
                      "Restart this task with a fresh worker? Active agents will be stopped first.",
                  }),
                );
              if (!confirmed) return;
              runMutation(() =>
                client.restartOrchestratorTask(taskId, { stopActive: true }),
              );
            }}
            onRestartWithEditedPlan={(input) =>
              runMutation(() =>
                client.restartOrchestratorTaskWithEditedPlan(taskId, input),
              )
            }
            onValidate={(passed) =>
              runMutation(() =>
                client.validateOrchestratorTask(taskId, {
                  passed,
                  humanOverride: true,
                }),
              )
            }
            onSetPriority={(priority) =>
              runMutation(() =>
                client.updateOrchestratorTask(taskId, { priority }),
              )
            }
            onToggleAddAgent={() => setAddAgentOpen((prev) => !prev)}
            onAddAgent={(input) =>
              runMutation(async () => {
                await client.addOrchestratorAgent(taskId, input);
                setAddAgentOpen(false);
              })
            }
            // The per-block/per-session detail drawer is deferred (v1): the pane
            // shows the inspector and transcript without the operator drawer.
            onInspectSession={() => {}}
            onStopAgent={(sessionId) =>
              runMutation(() => client.stopOrchestratorAgent(taskId, sessionId))
            }
            onCopyLink={() => {
              if (typeof window === "undefined" || !navigator.clipboard) return;
              void navigator.clipboard.writeText(
                `${window.location.origin}/orchestrator?task=${encodeURIComponent(taskId)}`,
              );
            }}
            t={t}
            locale={locale}
          />
        ) : null}
      </div>
    </div>
  );
}
