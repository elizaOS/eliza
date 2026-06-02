// odysseus Group Chat — multi-participant conversation surface (static/js/group.js
// + the group-chat rules in static/style.css). odysseus's group chat is a
// multi-MODEL room: a participant roster (N models, each optionally wearing a
// character) with ADD/REMOVE controls, a parallel/round-robin mode toggle, a
// shared message stream where every participant's reply is a per-model labelled +
// colour-tinted `.msg-group` bubble (group.js _createGroupBubble → applyModelColor),
// and a composer that fans one prompt out to all participants.
//
// elizaMapping: eliza has no "N independent model sessions in one room" backend —
// but the orchestrator DOES own real multi-participant task rooms, which is the
// faithful 1:1 mapping. A task thread IS a group: its `sessions` are the
// sub-agent participants (each with a framework/model label), the orchestrator
// is the coordinator participant, and the user is a participant too. So the
// roster is built from client.getCodingAgentTaskThread(taskId).sessions, the
// shared stream is the REAL room timeline via client.listOrchestratorTaskMessages
// (CodingAgentTaskMessageRecord[], senderKind = user|orchestrator|sub_agent|
// system), and the composer posts to the room via
// client.postOrchestratorTaskMessage(taskId, content) — the same endpoint the
// workbench composer uses. The task list comes from
// client.listCodingAgentTaskThreads so a room can be picked.
//
// Participant management is REAL: odysseus's add-participant (model + optional
// character) and per-row remove map to client.addOrchestratorAgent (spawn a
// sub-agent into the room) and client.stopOrchestratorAgent (stop a sub-agent) —
// the same endpoints the workbench's roster uses. odysseus's two-step
// model→character picker has no eliza analogue (eliza agents pick framework +
// model, not a character persona) so the add row exposes the real fields the
// orchestrator accepts (framework / model / label) rather than fabricating a
// character step. odysseus's saved GROUP PRESETS persist to /api/presets/groups,
// which eliza has no client method for, so presets are intentionally NOT
// rendered (no dead control) — see the deferred note in the handoff.
//
// odysseus's parallel/round-robin mode is a real UI affordance there but eliza's
// orchestrator schedules its own sub-agents — there is no client-exposed
// fan-out mode — so the mode toggle is a faithful local-only preference
// (persisted exactly like odysseus's GROUP_STATE_KEY via writePref) that is
// shown but annotated as not driving backend scheduling. When no task room is
// selected (or the agent has zero task threads) we render odysseus's honest
// empty state ("No group conversation") rather than fabricating participants or
// messages. No demo rosters, no fake replies, no fake streaming.

import {
  type CodingAgentAddAgentInput,
  type CodingAgentTaskMessageRecord,
  type CodingAgentTaskSessionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";
import { ListTree, Plus, Rows3, Send, Users, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { MarkdownText } from "../orchestrator-markdown";
import { formatClockTime, formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { LoadingRow } from "./Spinner";
import { readPref, writePref } from "./util/storage";

// odysseus persists its group config under GROUP_STATE_KEY
// ('odysseus-group-state'); the only client-relevant field here is `_mode`, so
// we own a single (non-shared) pref rather than bloating the shared PREF_KEYS
// table. Mirrors NotesPanel/CompareView's per-view-pref pattern.
const GROUP_MODE_KEY = "group-mode";

// odysseus's two fan-out modes (group.js `_mode`). Local-only here — see header.
type GroupMode = "parallel" | "round-robin";

function toMode(value: string): GroupMode {
  return value === "round-robin" ? "round-robin" : "parallel";
}

// A roster participant — the orchestrator coordinator, each sub-agent session,
// or the user. Mirrors odysseus's `_groupParticipants` entries (label + a
// secondary model/framework sublabel + a colour-dot kind).
type ParticipantKind = "user" | "orchestrator" | "sub_agent";

interface Participant {
  id: string;
  kind: ParticipantKind;
  label: string;
  sublabel: string;
  active: boolean;
  /** For sub-agents only: the session id the orchestrator stops by. */
  sessionId: string | null;
  /** The role-dot colour. Stable-hashed per participant for sub-agents (odysseus
   * applyModelColor) or a kind-fixed theme var for user/orchestrator/system. */
  dot: string;
}

// odysseus tints the role-dot of user/coordinator participants with fixed
// palette roles; sub-agents are hashed per-model below.
const KIND_DOT: Record<"user" | "orchestrator" | "system", string> = {
  user: "color-mix(in srgb, var(--fg) 40%, transparent)",
  orchestrator: "var(--accent, var(--red))",
  system: "color-mix(in srgb, var(--fg) 30%, transparent)",
};

/** A stable per-participant colour, mirroring chatRenderer.modelColor: hash the
 * key to a hue and emit an hsl() that reads on both dark and light odysseus
 * themes. Used so each sub-agent gets its OWN role-dot tint (odysseus
 * applyModelColor) instead of one shared green. */
function participantColor(key: string): string {
  let hash = 0;
  const lower = key.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash = ((hash << 5) - hash + lower.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}

/** A sub-agent session's display name — character/label first, else the
 * framework, mirroring group.js's `p.character ? name : model.display`. */
function sessionLabel(session: CodingAgentTaskSessionRecord): string {
  const label = session.label.trim();
  if (label) return label;
  return session.framework || "agent";
}

/** A sub-agent's sublabel — the model id, cleaned to the short tail the way
 * group.js does (`display.split('/').pop()`). */
function sessionSublabel(session: CodingAgentTaskSessionRecord): string {
  const model = session.model?.trim();
  if (!model) return session.framework || "";
  const tail = model.split("/").pop();
  return tail || model;
}

/** A sub-agent message that the backend never linked to a session still carries
 * the speaking participant in metadata — odysseus stores the participant name
 * under `group_model` (group.js _streamToHolder: metadata.group_model). Read it
 * defensively (metadata is Record<string, unknown>) so an unlinked sub_agent
 * bubble is still attributed to a real participant instead of "Agent". */
function metadataGroupModel(metadata: Record<string, unknown>): string | null {
  const value = metadata.group_model ?? metadata.model;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Build the room roster: user + orchestrator coordinator + each sub-agent
 * session. odysseus seeds the user implicitly and lists models explicitly; the
 * orchestrator room has the same three participant classes. Sub-agent dots are
 * hashed per session so the roster and the stream agree on each participant's
 * colour. */
function buildRoster(detail: CodingAgentTaskThreadDetail): Participant[] {
  const roster: Participant[] = [
    {
      id: "participant-user",
      kind: "user",
      label: "You",
      sublabel: "",
      active: true,
      sessionId: null,
      dot: KIND_DOT.user,
    },
    {
      id: "participant-orchestrator",
      kind: "orchestrator",
      label: "Orchestrator",
      sublabel: "coordinator",
      active: detail.status === "active",
      sessionId: null,
      dot: KIND_DOT.orchestrator,
    },
  ];
  for (const session of detail.sessions) {
    const label = sessionLabel(session);
    roster.push({
      id: session.id,
      kind: "sub_agent",
      label,
      sublabel: sessionSublabel(session),
      active: session.stoppedAt === null,
      sessionId: session.sessionId,
      dot: participantColor(label),
    });
  }
  return roster;
}

/** Resolve a stream message to its speaking participant: a stable display name
 * plus the role-dot colour, mirroring group.js's per-bubble roleLabel +
 * applyModelColor. user/orchestrator/system use fixed labels + palette dots;
 * a sub_agent resolves to its session label (else the metadata participant
 * name) and gets its OWN hashed colour so the stream reads as distinct voices. */
function resolveSender(
  message: CodingAgentTaskMessageRecord,
  sessionsById: ReadonlyMap<string, CodingAgentTaskSessionRecord>,
): { label: string; dot: string } {
  if (message.senderKind === "user") {
    return { label: "You", dot: KIND_DOT.user };
  }
  if (message.senderKind === "orchestrator") {
    return { label: "Orchestrator", dot: KIND_DOT.orchestrator };
  }
  if (message.senderKind === "system") {
    return { label: "System", dot: KIND_DOT.system };
  }
  if (message.sessionId) {
    const session = sessionsById.get(message.sessionId);
    if (session) {
      const label = sessionLabel(session);
      return { label, dot: participantColor(label) };
    }
  }
  const fromMetadata = metadataGroupModel(message.metadata);
  if (fromMetadata) {
    return { label: fromMetadata, dot: participantColor(fromMetadata) };
  }
  return { label: "Agent", dot: participantColor("agent") };
}

// A run of consecutive messages from the same speaker — odysseus renders one
// `.msg-group` bubble per turn, not one per delta. We coalesce same-sender runs
// (same senderKind + sessionId + resolved label) into a single bubble and show
// the role header (dot + name + time) once per run, mirroring the turn-grouping
// done for the main workbench conversation surface.
interface MessageRun {
  key: string;
  senderKind: CodingAgentTaskMessageRecord["senderKind"];
  label: string;
  dot: string;
  /** First message's timestamp — the one time shown for the whole run. */
  timestamp: number;
  isUser: boolean;
  messages: CodingAgentTaskMessageRecord[];
}

function coalesceRuns(
  messages: readonly CodingAgentTaskMessageRecord[],
  sessionsById: ReadonlyMap<string, CodingAgentTaskSessionRecord>,
): MessageRun[] {
  const runs: MessageRun[] = [];
  for (const message of messages) {
    const sender = resolveSender(message, sessionsById);
    const last = runs[runs.length - 1];
    const sameSpeaker =
      last !== undefined &&
      last.senderKind === message.senderKind &&
      last.label === sender.label &&
      // sessionId distinguishes two sub-agents that happen to share a label.
      last.messages[0].sessionId === message.sessionId;
    if (sameSpeaker) {
      last.messages.push(message);
      continue;
    }
    runs.push({
      key: message.id,
      senderKind: message.senderKind,
      label: sender.label,
      dot: sender.dot,
      timestamp: message.timestamp,
      isUser: message.senderKind === "user",
      messages: [message],
    });
  }
  return runs;
}

export function GroupChatView({
  open,
  onClose,
  locale,
  initialTaskId,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
  initialTaskId?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-group", { w: 860, h: 760 });
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [threadsFetched, setThreadsFetched] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    initialTaskId ?? null,
  );
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [messages, setMessages] = useState<CodingAgentTaskMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [mode, setMode] = useState<GroupMode>("parallel");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Participant management (odysseus add-participant / per-row remove).
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addFramework, setAddFramework] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Load the room list + restore the persisted mode when the view opens.
  useEffect(() => {
    if (!open) return;
    setMode(toMode(readPref<string>(GROUP_MODE_KEY, "parallel")));
    void client
      .listCodingAgentTaskThreads({ limit: 100 })
      .catch((): CodingAgentTaskThread[] => [])
      .then((list) => {
        setThreads(list);
        setThreadsFetched(true);
        setActiveTaskId((cur) => {
          if (cur && list.some((t) => t.id === cur)) return cur;
          if (initialTaskId && list.some((t) => t.id === initialTaskId)) {
            return initialTaskId;
          }
          return list.length > 0 ? list[0].id : null;
        });
      });
  }, [open, initialTaskId]);

  // Refetch the room detail (roster) + the shared message stream for the active
  // task. The orchestrator exposes a live SSE change stream per task, so we
  // subscribe and refetch the tail on every room mutation — the same pattern
  // the workbench uses for its conversation view.
  const reloadRoom = useCallback((taskId: string) => {
    setDetailLoading(true);
    void client
      .getCodingAgentTaskThread(taskId)
      .catch((): CodingAgentTaskThreadDetail | null => null)
      .then((d) => {
        setDetail(d);
        setDetailLoading(false);
      });
    setMessagesLoading(true);
    void client
      .listOrchestratorTaskMessages(taskId, { limit: 200 })
      .then((page) => {
        setMessages(page.items);
        setMessagesLoading(false);
      })
      .catch(() => {
        setMessages([]);
        setMessagesLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!open || !activeTaskId) {
      setDetail(null);
      setMessages([]);
      return;
    }
    // Reset transient per-room UI when the selected room changes.
    setSendError(null);
    setAdding(false);
    setAddError(null);
    reloadRoom(activeTaskId);
    const unsubscribe = client.streamOrchestratorTask(activeTaskId, () => {
      reloadRoom(activeTaskId);
    });
    return unsubscribe;
  }, [open, activeTaskId, reloadRoom]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, CodingAgentTaskSessionRecord>();
    if (detail) {
      for (const session of detail.sessions) map.set(session.id, session);
    }
    return map;
  }, [detail]);

  const roster = useMemo<Participant[]>(
    () => (detail ? buildRoster(detail) : []),
    [detail],
  );

  const runs = useMemo<MessageRun[]>(
    () => coalesceRuns(messages, sessionsById),
    [messages, sessionsById],
  );

  const setModePersist = (next: GroupMode) => {
    setMode(next);
    writePref(GROUP_MODE_KEY, next);
  };

  const send = () => {
    const content = draft.trim();
    if (!content || !activeTaskId || sending) return;
    setSending(true);
    setSendError(null);
    void client
      .postOrchestratorTaskMessage(activeTaskId, content)
      .then(
        (ok) => {
          if (ok) {
            setDraft("");
            reloadRoom(activeTaskId);
          } else {
            // The post was not fully delivered (recorded=false or a participant
            // rejected it). Keep the user's text and tell them.
            setSendError("Message could not be delivered to the room.");
          }
        },
        () => {
          setSendError("Failed to send. Check your connection and try again.");
        },
      )
      .finally(() => {
        setSending(false);
      });
  };

  // odysseus add-participant: spawn a real sub-agent into the room via the
  // orchestrator (client.addOrchestratorAgent — the same endpoint the workbench
  // roster uses). The orchestrator chooses sensible defaults when a field is
  // blank, so only the model/framework/label the user typed are sent.
  const addParticipant = () => {
    if (!activeTaskId || addBusy) return;
    const input: CodingAgentAddAgentInput = {
      framework: addFramework.trim() || undefined,
      model: addModel.trim() || undefined,
      label: addLabel.trim() || undefined,
    };
    setAddBusy(true);
    setAddError(null);
    void client
      .addOrchestratorAgent(activeTaskId, input)
      .then(
        (updated) => {
          if (updated) {
            setDetail(updated);
            setAdding(false);
            setAddFramework("");
            setAddModel("");
            setAddLabel("");
            reloadRoom(activeTaskId);
          } else {
            setAddError("This room no longer exists.");
          }
        },
        () => {
          setAddError("Failed to add participant.");
        },
      )
      .finally(() => {
        setAddBusy(false);
      });
  };

  // odysseus per-row remove: stop the sub-agent participant (client
  // .stopOrchestratorAgent). Only sub-agents are removable — the user and the
  // orchestrator coordinator are structural and have no session to stop.
  const removeParticipant = (participant: Participant) => {
    if (!activeTaskId || !participant.sessionId || removingId) return;
    setRemovingId(participant.id);
    void client
      .stopOrchestratorAgent(activeTaskId, participant.sessionId)
      .catch(() => false)
      .then(() => {
        reloadRoom(activeTaskId);
      })
      .finally(() => {
        setRemovingId(null);
      });
  };

  if (!open) return null;

  const activeThread = activeTaskId
    ? (threads.find((t) => t.id === activeTaskId) ?? null)
    : null;
  // The room is "empty" — odysseus's honest no-conversation state — when there
  // is no selectable task room at all.
  const noRoom = threadsFetched && threads.length === 0;
  const participantCount = roster.length;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Group chat"
    >
      <button
        type="button"
        aria-label="Close group chat"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-group-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Header (group.js showModelPicker modal-header) ── */}
        <div
          className="od-group-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-group-header-title">
            <Users size={14} aria-hidden="true" />
            <span>Group Chat</span>
            {participantCount > 0 ? (
              <span className="od-group-header-count">
                {participantCount} participant
                {participantCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
          <span className="od-group-header-spacer" />
          {/* Mode toggle — odysseus's #group-mode-btn (parallel / sequential). */}
          <button
            type="button"
            className={`od-group-mode-btn${mode === "parallel" ? " active" : ""}`}
            title={
              mode === "parallel"
                ? "All participants respond (parallel)"
                : "Round-robin — participants take turns"
            }
            aria-pressed={mode === "parallel"}
            onClick={() =>
              setModePersist(mode === "parallel" ? "round-robin" : "parallel")
            }
          >
            {mode === "parallel" ? (
              <Rows3 size={14} aria-hidden="true" />
            ) : (
              <ListTree size={14} aria-hidden="true" />
            )}
            <span className="od-group-mode-label">
              {mode === "parallel" ? "Parallel" : "Sequential"}
            </span>
          </button>
          <button
            type="button"
            className="od-group-close"
            aria-label="Close group chat"
            title="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Room picker (which task room to converse in) ── */}
        {threads.length > 0 ? (
          <div className="od-group-roompicker">
            <label
              className="od-group-roompicker-label"
              htmlFor="od-group-room"
            >
              Room
            </label>
            <select
              id="od-group-room"
              className="od-group-room-select"
              value={activeTaskId ?? ""}
              onChange={(e) => setActiveTaskId(e.target.value || null)}
              aria-label="Select task room"
            >
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="od-group-body">
          {/* ── Participant roster (group.js _render participant rows) ── */}
          <aside className="od-group-roster" aria-label="Participants">
            <div className="od-group-roster-head">
              <span>Participants</span>
              {activeTaskId && !noRoom ? (
                <button
                  type="button"
                  className="od-group-roster-add"
                  title="Add participant"
                  aria-label="Add participant"
                  aria-expanded={adding}
                  onClick={() => {
                    setAdding((v) => !v);
                    setAddError(null);
                  }}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {noRoom || !activeTaskId ? (
              <div className="od-group-roster-empty">No participants.</div>
            ) : detailLoading && roster.length === 0 ? (
              <div className="od-group-roster-empty">
                <LoadingRow label="Loading…" />
              </div>
            ) : (
              <div className="od-group-roster-list">
                {roster.map((p) => {
                  const removable = p.kind === "sub_agent" && p.active;
                  return (
                    <div
                      className={`od-group-participant${p.active ? "" : " idle"}`}
                      key={p.id}
                    >
                      <span
                        className="od-group-participant-dot"
                        style={{ background: p.dot }}
                        aria-hidden="true"
                      />
                      <span className="od-group-participant-text">
                        <span className="od-group-participant-name">
                          {p.label}
                        </span>
                        {p.sublabel && p.sublabel !== p.label ? (
                          <span className="od-group-participant-sub">
                            {p.sublabel}
                          </span>
                        ) : null}
                      </span>
                      {removable ? (
                        <button
                          type="button"
                          className="od-group-participant-remove"
                          title="Stop this participant"
                          aria-label={`Stop ${p.label}`}
                          disabled={removingId !== null}
                          onClick={() => removeParticipant(p)}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Add-participant row — odysseus's two-select picker; eliza spawns a
                real sub-agent so the fields are framework / model / label. */}
            {adding && activeTaskId && !noRoom ? (
              <div className="od-group-add">
                <input
                  className="od-group-add-input"
                  value={addFramework}
                  onChange={(e) => setAddFramework(e.target.value)}
                  placeholder="Framework (optional)"
                  aria-label="Participant framework"
                />
                <input
                  className="od-group-add-input"
                  value={addModel}
                  onChange={(e) => setAddModel(e.target.value)}
                  placeholder="Model (optional)"
                  aria-label="Participant model"
                />
                <input
                  className="od-group-add-input"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="Label (optional)"
                  aria-label="Participant label"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addParticipant();
                  }}
                />
                {addError ? (
                  <span className="od-group-add-error">{addError}</span>
                ) : null}
                <div className="od-group-add-foot">
                  <button
                    type="button"
                    className="od-group-add-cancel"
                    onClick={() => {
                      setAdding(false);
                      setAddError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="od-group-add-submit"
                    disabled={addBusy}
                    onClick={addParticipant}
                  >
                    {addBusy ? "Adding…" : "Add"}
                  </button>
                </div>
              </div>
            ) : null}
          </aside>

          {/* ── Shared message stream (group.js chat-history .msg-group) ── */}
          <div className="od-group-stream-wrap">
            <div className="od-group-stream">
              {noRoom ? (
                <div className="od-group-empty">
                  No group conversation. The orchestrator opens a task room with
                  its sub-agents when you start a coding job — that room becomes
                  the group chat.
                </div>
              ) : !activeTaskId ? (
                <div className="od-group-empty">No group conversation.</div>
              ) : messagesLoading && messages.length === 0 ? (
                <div className="od-group-empty">
                  <LoadingRow label="Loading conversation…" />
                </div>
              ) : runs.length === 0 ? (
                <div className="od-group-empty">
                  No messages in this room yet.
                </div>
              ) : (
                runs.map((run) => (
                  <div
                    className={`od-msg od-msg-group${
                      run.isUser ? " od-msg-user" : " od-msg-ai"
                    }`}
                    key={run.key}
                  >
                    {run.isUser ? null : (
                      <div className="od-role">
                        <span
                          className="od-group-role-dot"
                          style={{ background: run.dot }}
                          aria-hidden="true"
                        />
                        <span className="od-group-role-name">{run.label}</span>
                        <span className="od-group-role-time">
                          {formatClockTime(run.timestamp, locale)}
                        </span>
                      </div>
                    )}
                    {run.messages.map((message) => (
                      <div
                        className="od-body"
                        key={message.id}
                        style={
                          message.direction === "stderr"
                            ? { color: "var(--red)" }
                            : undefined
                        }
                      >
                        <MarkdownText text={message.content} />
                      </div>
                    ))}
                    {run.isUser ? (
                      <div className="od-msg-time">
                        {formatClockTime(run.timestamp, locale)}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {/* ── Composer (group.js sendMessage → fan-out; here: room post) ── */}
            <div className="od-group-composer">
              <textarea
                className="od-group-input"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (sendError) setSendError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    onClose();
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  activeTaskId
                    ? "Message the room — every participant sees it…"
                    : "Select a room to start the group conversation…"
                }
                aria-label="Group message"
                disabled={!activeTaskId || noRoom}
              />
              <button
                type="button"
                className="od-group-send"
                title="Send to all participants"
                aria-label="Send"
                disabled={!draft.trim() || !activeTaskId || sending}
                onClick={send}
              >
                <Send size={14} />
              </button>
            </div>
            {sendError ? (
              <div className="od-group-send-error" role="alert">
                {sendError}
              </div>
            ) : null}
            {/* odysseus's mode toggle drives real fan-out scheduling; eliza's
                orchestrator schedules its own sub-agents, so the toggle above is
                a local preference and does not change room delivery. */}
            <div className="od-group-note">
              {activeThread ? (
                <span>
                  Posting to <strong>{activeThread.title}</strong> ·{" "}
                  {activeThread.latestActivityAt
                    ? `active ${formatRelativeTime(activeThread.latestActivityAt, locale)}`
                    : "no activity yet"}
                </span>
              ) : (
                <span>
                  The orchestrator delivers room messages to its sub-agents; the
                  Parallel / Sequential toggle is a local preference and doesn’t
                  change delivery.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
