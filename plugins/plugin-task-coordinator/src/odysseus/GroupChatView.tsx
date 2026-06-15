// odysseus Group — the multi-model "group chat" composer (static/js/group.js +
// the #custom-preset-modal[data-chartab-panel="group"] markup in
// static/index.html L1179-1188, styled by the .compare-parallel-toggle /
// .preset-* rules in static/style.css).
//
// IMPORTANT — surface shape: odysseus's "Group" is NOT a standalone window. It
// is a TAB inside the Prompt/Persona modal. Its tab body is, top-to-bottom:
//   1. a single full-width Sequential/Parallel mode toggle (.compare-parallel-toggle,
//      default 'round-robin' → label "Sequential"; group.js L18),
//   2. a stacked #group-participants list — minimal rows (12px name + a dim
//      10px model sublabel + a plain "×" remove), NO status dots, NO idle
//      dimming (group.js _render L63-79),
//   3. a full-width DASHED "+ Add participant" button that expands to a two-
//      <select> persona+model picker, auto-adding on model change, max 8
//      (group.js L83-116),
// and the modal's shared footer carries Cancel + a "Start" button (index.html
// L1191-1195) that fans the chosen participants out into a fresh group.
//
// elizaMapping: eliza has no "N independent model sessions" fan-out backend, but
// the orchestrator DOES own real multi-participant task rooms, which is the
// faithful mapping. A task thread IS a group: its `sessions` are the sub-agent
// participants and the orchestrator coordinates them. odysseus's add-participant
// (persona + model) maps to client.addOrchestratorAgent (spawn a real sub-agent
// into the room) and per-row "×" maps to client.stopOrchestratorAgent — the
// same endpoints the workbench roster uses. eliza agents pick framework + model
// (not a character persona), so the picker exposes the real fields the
// orchestrator accepts (framework / model / label) instead of fabricating a
// persona step — a documented, intentional substitution (see deferred note).
//
// Two odysseus affordances are intentionally NOT cloned, to avoid slop:
//   • odysseus's group is created fresh from the participant list with no notion
//     of an existing "room"; eliza MUST attach sub-agents to a concrete task
//     room, so a single room-target <select> is kept and documented as an
//     intentional eliza-only deviation (NOT presented as 1:1).
//   • saved GROUP PRESETS (#group-presets-list, /api/presets/groups) — eliza has
//     no preset/group client method, so no chip row is rendered (no dead control).
//
// The bespoke floating-window chrome of the prior port (titled "Group Chat"
// header + participant-count badge, room-picker ROW, roster-beside-stream two
// column body, in-panel composer + "Posting to …" note + per-bubble stream) had
// no counterpart in the real frame and has been removed: odysseus's group tab
// has no composer (messages go through the main chat bar after Start) and no
// stream of its own.

import {
  type CodingAgentAddAgentInput,
  type CodingAgentTaskSessionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";
import { Minus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { LoadingRow } from "./Spinner";
import { readPref, writePref } from "./util/storage";

// odysseus persists its group config under GROUP_STATE_KEY
// ('odysseus-group-state'); the only client-relevant field is `_mode`, so we
// own a single (non-shared) pref rather than bloating the shared PREF_KEYS
// table. Mirrors NotesPanel/CompareView's per-view-pref pattern.
const GROUP_MODE_KEY = "group-mode";

// odysseus's two fan-out modes (group.js `_mode`). The default is 'round-robin'
// (group.js L18) → the toggle shows "Sequential" at rest and gets the .active
// accent only when flipped to 'parallel'. Local-only here — see header.
type GroupMode = "parallel" | "round-robin";

function toMode(value: string): GroupMode {
  // odysseus defaults to round-robin; only an explicit 'parallel' flips it.
  return value === "parallel" ? "parallel" : "round-robin";
}

/** A sub-agent session's display name — label first, else the framework,
 * mirroring group.js's `p.character ? name : model.display`. */
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

// A row in the group participant list. odysseus rows are character/model entries
// the user has staged; here each row is a real sub-agent session already in the
// room (the orchestrator is always present implicitly as the coordinator, so it
// is not listed as a removable participant — only spawned sub-agents are).
interface Participant {
  id: string;
  label: string;
  sublabel: string;
  /** The session id the orchestrator stops by, for the row "×" remove. */
  sessionId: string | null;
}

/** Build the staged-participant list from the room's sub-agent sessions.
 * odysseus lists models the user has added; the orchestrator room's analogue is
 * its live sub-agent sessions (the user + orchestrator coordinator are
 * structural and implied, not rows in this list — matching odysseus, where the
 * list holds only the added models, not "you"). */
function buildParticipants(detail: CodingAgentTaskThreadDetail): Participant[] {
  return detail.sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session),
    sublabel: sessionSublabel(session),
    sessionId: session.sessionId,
  }));
}

// odysseus caps a group at 8 models (group.js L104). Mirror the cap on the real
// roster so "Add participant" disables at the same ceiling.
const MAX_PARTICIPANTS = 8;

export function GroupChatView({
  open,
  onClose,
  initialTaskId,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
  initialTaskId?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  // odysseus's group tab lives inside the compact #custom-preset-modal
  // (min(460px,90vw)); size the window to match rather than the prior large
  // 860×760 floating window.
  const win = useWindowControls(
    "win-group",
    { w: 460, h: 540 },
    { label: "Group Chat", icon: "MessagesSquare", onClose },
  );
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [threadsFetched, setThreadsFetched] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    initialTaskId ?? null,
  );
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [mode, setMode] = useState<GroupMode>("round-robin");
  // Participant management (odysseus add-participant / per-row remove).
  const [picking, setPicking] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addFramework, setAddFramework] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // "Start" → kick the room with the chosen mode. Honest about delivery (see note).
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Load the room list + restore the persisted mode when the view opens.
  useEffect(() => {
    if (!open) return;
    setMode(toMode(readPref<string>(GROUP_MODE_KEY, "round-robin")));
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

  // Refetch the room detail (the staged participant list) for the active task.
  // The orchestrator exposes a live SSE change stream per task, so we subscribe
  // and refetch on every room mutation — the same pattern the workbench uses.
  const reloadRoom = useCallback((taskId: string) => {
    setDetailLoading(true);
    void client
      .getCodingAgentTaskThread(taskId)
      .catch((): CodingAgentTaskThreadDetail | null => null)
      .then((d) => {
        setDetail(d);
        setDetailLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!open || !activeTaskId) {
      setDetail(null);
      return;
    }
    // Reset transient per-room UI when the selected room changes. Clear the
    // previous room's detail FIRST so its now-foreign participant rows can't
    // render or be acted on (remove/start) against the new room while the
    // refetch is in flight.
    setDetail(null);
    setPicking(false);
    setAddError(null);
    setStartError(null);
    setRemoveError(null);
    reloadRoom(activeTaskId);
    const unsubscribe = client.streamOrchestratorTask(activeTaskId, () => {
      reloadRoom(activeTaskId);
    });
    return unsubscribe;
  }, [open, activeTaskId, reloadRoom]);

  const setModePersist = (next: GroupMode) => {
    setMode(next);
    writePref(GROUP_MODE_KEY, next);
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
            setPicking(false);
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
  // .stopOrchestratorAgent).
  const removeParticipant = (participant: Participant) => {
    if (!activeTaskId || !participant.sessionId || removingId) return;
    setRemovingId(participant.id);
    setRemoveError(null);
    void client
      .stopOrchestratorAgent(activeTaskId, participant.sessionId)
      .then(
        () => {
          if (activeTaskId) reloadRoom(activeTaskId);
        },
        () => {
          // Don't reload on failure — the row really is still there, so leave
          // it and surface the error instead of silently re-rendering it back.
          setRemoveError(`Could not remove ${participant.label}.`);
        },
      )
      .finally(() => {
        setRemovingId(null);
      });
  };

  // odysseus's footer "Start" fans the staged participants out into a fresh
  // group and closes the modal (group.js L130-159; needs ≥2 participants). The
  // faithful eliza analogue is a real room kickoff: post the chosen mode as a
  // room message so the orchestrator and its sub-agents see the same prompt,
  // then close — the same postOrchestratorTaskMessage endpoint the workbench
  // composer uses. (The Parallel/Sequential mode itself is a local preference;
  // it does not drive backend scheduling — see the foot note.)
  const start = (participantCount: number) => {
    if (!activeTaskId || starting) return;
    if (participantCount < 2) {
      setStartError("Need at least 2 participants — add models.");
      return;
    }
    setStarting(true);
    setStartError(null);
    void client
      .postOrchestratorTaskMessage(
        activeTaskId,
        mode === "parallel"
          ? "Group started — all participants respond."
          : "Group started — participants respond in turn.",
      )
      .then(
        (ok) => {
          if (ok) {
            onClose();
          } else {
            setStartError("Could not start the group in this room.");
          }
        },
        () => {
          setStartError("Failed to start. Check your connection.");
        },
      )
      .finally(() => {
        setStarting(false);
      });
  };

  if (!open) return null;
  if (win.minimized) return null;

  // The group is "empty" — odysseus's honest no-conversation state — when there
  // is no selectable task room at all.
  const noRoom = threadsFetched && threads.length === 0;
  const participants = detail ? buildParticipants(detail) : [];
  const canStart = participants.length >= 2 && !!activeTaskId && !noRoom;
  const atCap = participants.length >= MAX_PARTICIPANTS;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Group"
    >
      <button
        type="button"
        aria-label="Close group"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-group-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Modal header (index.html #custom-preset-modal .modal-header;
            the active tab here is "Group" + the modal's own close-btn) ── */}
        <div
          className="od-group-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-group-header-title">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>Group</span>
          </span>
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-group-close"
            aria-label="Close group"
            title="Close"
            onClick={onClose}
          >
            ✖
          </button>
        </div>

        <div className="od-group-tab">
          {/* ── Room target — eliza-only deviation (a group must attach to a
              concrete orchestrator task room). Documented; not 1:1 odysseus. ── */}
          {threads.length > 0 ? (
            <div className="od-group-roomrow">
              <label className="od-group-roomlabel" htmlFor="od-group-room">
                Room
              </label>
              <select
                id="od-group-room"
                className="od-group-roomselect"
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

          {/* ── Mode toggle (group.js #group-mode-btn, .compare-parallel-toggle
              styling; default Sequential, custom line/dot SVGs) ── */}
          <div className="od-group-moderow">
            <button
              type="button"
              className={`od-group-mode-btn${mode === "parallel" ? " active" : ""}`}
              title={
                mode === "parallel"
                  ? "All participants respond"
                  : "Round-robin — participants take turns"
              }
              aria-pressed={mode === "parallel"}
              onClick={() =>
                setModePersist(mode === "parallel" ? "round-robin" : "parallel")
              }
            >
              {mode === "parallel" ? (
                // ICON_PAR — three flush lines (group.js L120).
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </svg>
              ) : (
                // ICON_SEQ — three lines with leading dots (group.js L121).
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="8" y1="6" x2="20" y2="6" />
                  <line x1="8" y1="12" x2="20" y2="12" />
                  <line x1="8" y1="18" x2="20" y2="18" />
                  <circle cx="4" cy="6" r="1.5" fill="currentColor" />
                  <circle cx="4" cy="12" r="1.5" fill="currentColor" />
                  <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                </svg>
              )}
              <span className="od-group-mode-label">
                {mode === "parallel" ? "Parallel" : "Sequential"}
              </span>
            </button>
          </div>

          {/* ── Participant list (group.js #group-participants _render rows) ── */}
          <div className="od-group-participants">
            {noRoom || !activeTaskId ? (
              <div className="od-group-participants-empty">No room.</div>
            ) : detailLoading && participants.length === 0 ? (
              <div className="od-group-participants-empty">
                <LoadingRow label="Loading…" />
              </div>
            ) : participants.length === 0 ? (
              <div className="od-group-participants-empty">Add a model.</div>
            ) : (
              participants.map((p) => (
                <div className="od-group-participant" key={p.id}>
                  <span className="od-group-participant-text">
                    <span className="od-group-participant-name">{p.label}</span>
                    {p.sublabel && p.sublabel !== p.label ? (
                      <span className="od-group-participant-sub">
                        {p.sublabel}
                      </span>
                    ) : null}
                  </span>
                  {p.sessionId ? (
                    <button
                      type="button"
                      className="od-group-participant-remove"
                      title="Remove"
                      aria-label={`Remove ${p.label}`}
                      disabled={removingId !== null}
                      onClick={() => removeParticipant(p)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {/* Remove failed — the "×" hit the orchestrator but stopOrchestratorAgent
              rejected, so the row is genuinely still present. Surface it here
              rather than silently reloading the same row back. */}
          {removeError ? (
            <span className="od-group-picker-error" role="alert">
              {removeError}
            </span>
          ) : null}

          {/* ── Add-participant: odysseus's dashed full-width button →
              inline picker (group.js #group-add-btn). eliza spawns a real
              sub-agent so the picker fields are framework / model / label
              (documented deviation from odysseus's persona+model selects). ── */}
          {picking && activeTaskId && !noRoom ? (
            <div className="od-group-picker">
              <input
                className="od-group-picker-input"
                value={addFramework}
                onChange={(e) => setAddFramework(e.target.value)}
                placeholder="Framework (optional)"
                aria-label="Participant framework"
              />
              <input
                className="od-group-picker-input"
                value={addModel}
                onChange={(e) => setAddModel(e.target.value)}
                placeholder="Model (optional)"
                aria-label="Participant model"
              />
              <input
                className="od-group-picker-input"
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                placeholder="Label (optional)"
                aria-label="Participant label"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addParticipant();
                }}
              />
              {addError ? (
                <span className="od-group-picker-error">{addError}</span>
              ) : null}
              <div className="od-group-picker-foot">
                <button
                  type="button"
                  className="od-group-picker-cancel"
                  onClick={() => {
                    setPicking(false);
                    setAddError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="od-group-picker-submit"
                  disabled={addBusy}
                  onClick={addParticipant}
                >
                  {addBusy ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="od-group-add-btn"
              disabled={!activeTaskId || noRoom || atCap}
              title={
                atCap
                  ? "Maximum 8 participants"
                  : "Add a participant to the group"
              }
              onClick={() => {
                setPicking(true);
                setAddError(null);
              }}
            >
              + Add participant
            </button>
          )}
        </div>

        {/* ── Footer (index.html .modal-footer: Cancel + Start) ── */}
        <div className="od-group-footer">
          {startError ? (
            <span className="od-group-footer-error" role="alert">
              {startError}
            </span>
          ) : null}
          <span className="od-group-footer-spacer" />
          <button type="button" className="od-group-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="od-group-start"
            disabled={!canStart || starting}
            title={
              canStart
                ? "Start the group"
                : "Add at least 2 participants to start"
            }
            onClick={() => start(participants.length)}
          >
            {starting ? null : (
              // Leading play triangle — the real Prompt modal's shared footer
              // button (index.html #save-custom-preset / PresetsPanel
              // .od-preset-start-btn) carries a "▶" glyph before its label.
              <svg
                className="od-group-start-glyph"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
            {starting ? "Starting…" : "Start"}
          </button>
        </div>

        {/* odysseus's mode toggle drives real fan-out scheduling; eliza's
            orchestrator schedules its own sub-agents, so the toggle above is a
            local preference and does not change room delivery. */}
        <div className="od-group-note">
          The orchestrator delivers room messages to its sub-agents; the
          Parallel / Sequential toggle is a local preference and doesn’t change
          delivery.
        </div>
      </div>
    </div>
  );
}
