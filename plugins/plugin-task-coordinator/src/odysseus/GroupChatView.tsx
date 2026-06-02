// odysseus Group Chat — multi-participant conversation surface (static/js/group.js
// + the group-chat rules in static/style.css). odysseus's group chat is a
// multi-MODEL room: a participant roster (N models, each optionally wearing a
// character), a parallel/round-robin mode toggle, a shared message stream where
// every participant's reply is a labelled `.msg-group` bubble, and a composer
// that fans one prompt out to all participants.
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
// odysseus's parallel/round-robin mode is a real UI affordance there but eliza's
// orchestrator schedules its own sub-agents — there is no client-exposed
// fan-out mode — so the mode toggle is a faithful local-only preference
// (persisted exactly like odysseus's GROUP_STATE_KEY via writePref) that is
// shown but annotated as not driving backend scheduling. When no task room is
// selected (or the agent has zero task threads) we render odysseus's honest
// empty state ("No group conversation") rather than fabricating participants or
// messages. No demo rosters, no fake replies, no fake streaming.

import {
  type CodingAgentTaskMessageRecord,
  type CodingAgentTaskSessionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";
import { ListTree, Rows3, Send, Users, X } from "lucide-react";
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
}

// odysseus colours each participant's role-dot per model; we map the dot to a
// theme var per participant kind so it inherits the active odysseus palette.
const KIND_DOT: Record<ParticipantKind, string> = {
  user: "color-mix(in srgb, var(--fg) 40%, transparent)",
  orchestrator: "var(--accent, var(--red))",
  sub_agent: "var(--ok)",
};

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

/** Build the room roster: user + orchestrator coordinator + each sub-agent
 * session. odysseus seeds the user implicitly and lists models explicitly; the
 * orchestrator room has the same three participant classes. */
function buildRoster(detail: CodingAgentTaskThreadDetail): Participant[] {
  const roster: Participant[] = [
    {
      id: "participant-user",
      kind: "user",
      label: "You",
      sublabel: "",
      active: true,
    },
    {
      id: "participant-orchestrator",
      kind: "orchestrator",
      label: "Orchestrator",
      sublabel: "coordinator",
      active: detail.status === "active",
    },
  ];
  for (const session of detail.sessions) {
    roster.push({
      id: session.id,
      kind: "sub_agent",
      label: sessionLabel(session),
      sublabel: sessionSublabel(session),
      active: session.stoppedAt === null,
    });
  }
  return roster;
}

/** A stream message's sender label. user → "You"; sub_agent → the matching
 * session's label (falling back to the message's own sessionId); orchestrator /
 * system → fixed labels. Mirrors group.js's per-bubble `roleLabel`. */
function senderLabel(
  message: CodingAgentTaskMessageRecord,
  sessionsById: ReadonlyMap<string, CodingAgentTaskSessionRecord>,
): string {
  if (message.senderKind === "user") return "You";
  if (message.senderKind === "orchestrator") return "Orchestrator";
  if (message.senderKind === "system") return "System";
  if (message.sessionId) {
    const session = sessionsById.get(message.sessionId);
    if (session) return sessionLabel(session);
  }
  return "Agent";
}

function senderDot(kind: CodingAgentTaskMessageRecord["senderKind"]): string {
  if (kind === "user") return KIND_DOT.user;
  if (kind === "orchestrator") return KIND_DOT.orchestrator;
  if (kind === "system")
    return "color-mix(in srgb, var(--fg) 30%, transparent)";
  return KIND_DOT.sub_agent;
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

  const setModePersist = (next: GroupMode) => {
    setMode(next);
    writePref(GROUP_MODE_KEY, next);
  };

  const send = () => {
    const content = draft.trim();
    if (!content || !activeTaskId || sending) return;
    setSending(true);
    void client
      .postOrchestratorTaskMessage(activeTaskId, content)
      .catch(() => false)
      .then(() => {
        setDraft("");
        setSending(false);
        reloadRoom(activeTaskId);
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
            <div className="od-group-roster-head">Participants</div>
            {noRoom || !activeTaskId ? (
              <div className="od-group-roster-empty">No participants.</div>
            ) : detailLoading && roster.length === 0 ? (
              <div className="od-group-roster-empty">Loading…</div>
            ) : (
              <div className="od-group-roster-list">
                {roster.map((p) => (
                  <div
                    className={`od-group-participant${p.active ? "" : " idle"}`}
                    key={p.id}
                  >
                    <span
                      className="od-group-participant-dot"
                      style={{ background: KIND_DOT[p.kind] }}
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
                  </div>
                ))}
              </div>
            )}
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
                <div className="od-group-empty">Loading conversation…</div>
              ) : messages.length === 0 ? (
                <div className="od-group-empty">
                  No messages in this room yet.
                </div>
              ) : (
                messages.map((message) => {
                  const isUser = message.senderKind === "user";
                  const tone = message.direction === "stderr";
                  return (
                    <div
                      className={`od-msg od-msg-group${
                        isUser ? " od-msg-user" : " od-msg-ai"
                      }`}
                      key={message.id}
                    >
                      {isUser ? null : (
                        <div className="od-role">
                          <span
                            className="od-group-role-dot"
                            style={{
                              background: senderDot(message.senderKind),
                            }}
                            aria-hidden="true"
                          />
                          <span className="od-group-role-name">
                            {senderLabel(message, sessionsById)}
                          </span>
                          <span className="od-group-role-time">
                            {formatClockTime(message.timestamp, locale)}
                          </span>
                        </div>
                      )}
                      <div
                        className="od-body"
                        style={tone ? { color: "var(--red)" } : undefined}
                      >
                        <MarkdownText text={message.content} />
                      </div>
                      {isUser ? (
                        <div className="od-msg-time">
                          {formatClockTime(message.timestamp, locale)}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            {/* ── Composer (group.js sendMessage → fan-out; here: room post) ── */}
            <div className="od-group-composer">
              <textarea
                className="od-group-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
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
