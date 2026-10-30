/** One canonical editor for the signed app view and embedded hosts. */
import { useAgentElement } from "@elizaos/ui/view-primitives";
import {
  type ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { NotesClient, NotesInteractResult } from "../client/notes-api.js";
import {
  NotesController,
  type NotesPhase,
} from "../client/notes-controller.js";
import { NotesEditor } from "../client/notes-editor.js";
import { authoredNoteText } from "../note-authored.js";
import {
  type NoteFormat,
  type NoteJson,
  type NotesSnapshot,
  reconstructNoteContent,
  type StickyNote,
} from "../types.js";
import { NotesSurface } from "./NotesSurface.js";
import { AgentAction } from "./viewPrimitives.js";

export interface NotesWorkspacePorts {
  copyText?(note: StickyNote, signal: AbortSignal): Promise<void>;
  share?(note: StickyNote, signal: AbortSignal): Promise<void>;
  exportText?(note: StickyNote, signal: AbortSignal): Promise<void>;
  composeEmail?(note: StickyNote, signal: AbortSignal): Promise<void>;
  readAloud?(note: StickyNote, signal: AbortSignal): Promise<void>;
  dictate?(signal: AbortSignal): Promise<string>;
  openSource?(note: StickyNote, signal: AbortSignal): Promise<void>;
  /**
   * Opens a reviewed Calendar event draft from this note (see `noteScheduleDraft`). Nothing is
   * scheduled until the owner saves it there; the host stores the draft's origin link with the
   * saved event.
   */
  draftEvent?(note: StickyNote, signal: AbortSignal): Promise<void>;
  /** As {@link draftEvent}, for a reminder draft. */
  draftReminder?(note: StickyNote, signal: AbortSignal): Promise<void>;
}
export interface NotesWorkspaceProps {
  /** Retained hidden hosts keep drafts but admit no foreground actions. */
  active?: boolean;
  client: NotesClient;
  binding: { key: string; current(): boolean };
  events?: {
    subscribeInvalidation(listener: (revision?: number) => void): () => void;
  };
  sourceNoteTarget?: { id: string; sequence: number } | null;
  onSelectionChange?(selection: ReturnType<NotesEditor["selection"]>): void;
  sources?: readonly {
    id: string;
    label: string;
    selected: boolean;
    select(): Promise<void>;
  }[];
  ports?: NotesWorkspacePorts;
  onOperationError?(cause: unknown): void;
}
export interface NotesWorkspaceHandle {
  current(): boolean;
  requestLeave(): Promise<boolean>;
  hasUnsavedChanges(): boolean;
  isEditing(): boolean;
  pending(): boolean;
  revision(): number | null;
  snapshot(): NotesSnapshot | null;
  selection(): ReturnType<NotesEditor["selection"]>;
  refresh(): Promise<void>;
  /** Explicit host commands share this controller even while its UI is hidden. */
  interact(
    capability: string,
    params?: Record<string, unknown>,
  ): Promise<NotesInteractResult>;
  begin(kind?: "text" | "list"): boolean;
  retire(): void;
}
type Session = { controller: NotesController; editor: NotesEditor };
const failure = (cause: unknown) =>
  cause instanceof Error
    ? cause
    : new Error("Notes could not reach the agent.", { cause });
const record = (value: NoteJson): value is Record<string, NoteJson> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const items = (format: NoteFormat | undefined, key = "items") => {
  const value = format?.data[key];
  return Array.isArray(value) ? value : [];
};
const text = (value: NoteJson) =>
  record(value) && typeof value.t === "string" ? value.t : "";

function VoiceAction({
  item,
  index,
  toggle,
}: {
  item: Record<string, NoteJson>;
  index: number;
  toggle(): void;
}) {
  const label = `${item.done ? "Uncheck" : "Check"} ${String(item.t)}`;
  const control = useAgentElement<HTMLInputElement>({
    id: `notes-action-${index}`,
    role: "toggle",
    group: "notes-editor",
    label,
    onActivate: toggle,
  });
  return (
    <label className="notes-workspace-item">
      <input
        {...control.agentProps}
        ref={control.ref}
        type="checkbox"
        checked={item.done === true}
        onChange={toggle}
      />
      {String(item.t)}
    </label>
  );
}

const styles = `
.notes-workspace-root{background:var(--bg,transparent);display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color:var(--text,var(--fg,#202020));font:inherit}.notes-workspace-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;flex:1;padding-bottom:var(--eliza-chat-clearance,0px);scroll-padding-bottom:var(--eliza-chat-clearance,0px)}
.notes-workspace-root button{font:inherit;color:inherit;min-height:2.75rem;padding:.55rem .8rem;border:1px solid var(--border,#8888);border-radius:var(--radius-sm,.5rem);background:var(--surface,var(--bg,transparent));cursor:pointer}.notes-workspace-root button:disabled{opacity:.5;cursor:default}.notes-workspace-root :focus-visible{outline:2px solid var(--ring,currentColor);outline-offset:2px}.notes-workspace-root ul[data-testid=simple-notes-list]{display:grid;grid-template-columns:minmax(0,1fr);gap:.75rem}.notes-workspace-root li[role=button]{cursor:pointer}
.notes-workspace-toolbar,.notes-workspace-actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-block:.5rem 1rem}
.notes-workspace-toolbar input{flex:1;min-width:8rem}.notes-workspace-columns{min-width:0}.notes-workspace-columns>section{min-width:0}
.notes-workspace-editor{min-width:0;max-width:45rem;width:100%;margin-inline:auto;box-sizing:border-box}
.notes-workspace-editor input,.notes-workspace-editor textarea,.notes-workspace-toolbar input{box-sizing:border-box;font:inherit;color:inherit;background:var(--input,var(--card,transparent));border:1px solid var(--border,#8888);border-radius:var(--radius-sm,.5rem);padding:.75rem;min-height:2.75rem}
.notes-workspace-editor>label{display:block;margin-block:.75rem}.notes-workspace-editor>label>input,.notes-workspace-editor>label>textarea{display:block;width:100%;margin-top:.35rem}
.notes-workspace-editor textarea{resize:vertical;min-height:18rem;line-height:1.6}.notes-workspace-item{display:flex;gap:.5rem;align-items:center;margin-block:.5rem}.notes-workspace-item input[type=text]{flex:1;min-width:0}.notes-workspace-item input[type=checkbox]{min-width:1.5rem;min-height:1.5rem}
.notes-workspace-message{padding:.75rem;border:1px solid var(--border,#8888);border-radius:var(--radius-sm,.5rem);margin-block:.5rem;overflow-wrap:anywhere}
.notes-workspace-columns.has-editor>section:not(.notes-workspace-editor){display:none}.notes-workspace-rich{white-space:pre-wrap;overflow-wrap:anywhere}.notes-workspace-trash{list-style:none;padding:0}.notes-workspace-trash li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem;border-bottom:1px solid var(--border,#8888)}
@media(min-width:64rem){.notes-workspace-root .notes-workspace-columns:not(.has-editor) ul[data-testid=simple-notes-list]{grid-template-columns:repeat(2,minmax(0,1fr))}.notes-workspace-columns.has-editor{display:grid;grid-template-columns:minmax(15rem,1fr) minmax(0,2fr);gap:1.5rem}.notes-workspace-columns.has-editor>section:not(.notes-workspace-editor){display:block}}
@media(prefers-reduced-motion:reduce){.notes-workspace-columns *{scroll-behavior:auto}}
`;

/** A binding change remounts the session before old-owner content can render. */
export const NotesWorkspace = forwardRef<
  NotesWorkspaceHandle,
  NotesWorkspaceProps
>(function NotesWorkspace(props, ref) {
  return (
    <WorkspaceSession key={props.binding.key} {...props} workspaceRef={ref} />
  );
});

function WorkspaceSession(
  props: NotesWorkspaceProps & {
    workspaceRef: ForwardedRef<NotesWorkspaceHandle>;
  },
) {
  const latest = useRef(props);
  latest.current = props;
  const isActive = useCallback(() => latest.current.active !== false, []);
  const [session, setSession] = useState<Session | null>(null);
  const [published, setPublished] = useState<NotesSnapshot | null>(null);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [phase, setPhase] = useState<NotesPhase>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [review, setReview] = useState(false);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [notice, setNotice] = useState("");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [portBusy, setPortBusy] = useState(false);
  const action = useRef<AbortController | null>(null);
  const deferredInvalidation = useRef(false);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.active === false) action.current?.abort();
  }, [props.active]);

  useEffect(() => {
    let active = true;
    const current = () => active && latest.current.binding.current();
    let editor: NotesEditor;
    const controller = new NotesController(props.client, current, {
      snapshot: (value) => {
        if (current()) {
          setPublished(value);
          setError(null);
          editor.reconcile();
          redraw();
        }
      },
      phase: (value) => {
        if (current()) setPhase(value);
      },
      failed: (cause) => {
        if (current()) setError(failure(cause));
      },
    });
    editor = new NotesEditor(controller, {
      changed: () => {
        if (current()) redraw();
      },
      committed: () => {
        if (current()) {
          setReview(false);
          redraw();
        }
      },
      review: () => {
        if (current()) setReview(true);
      },
    });
    setSession({ controller, editor });
    const unsubscribe = props.events?.subscribeInvalidation((revision) => {
      if (!isActive()) {
        deferredInvalidation.current = true;
      } else controller.invalidate(revision);
    });
    void controller.refresh().catch(() => {});
    return () => {
      active = false;
      action.current?.abort();
      unsubscribe?.();
      editor.close();
      controller.retire();
    };
  }, [props.client, props.events, isActive]);
  useEffect(() => {
    if (props.active !== false && session && deferredInvalidation.current) {
      deferredInvalidation.current = false;
      session.controller.invalidate();
    }
  }, [props.active, session]);

  const current = !!session?.controller.current && props.binding.current();
  const snapshot = current ? published : null;
  const draft = current ? session.editor.draft : null;
  const busy = phase === "saving";
  const leave = useCallback(async () => {
    if (!session?.controller.current) return false;
    const captured = session.editor.draft;
    if (
      captured?.version &&
      (captured.id || session.editor.hasAuthoredContent)
    ) {
      if (!(await session.editor.save())) return false;
    }
    if (
      !session.controller.current ||
      captured?.token !== session.editor.draft?.token
    )
      return false;
    session.editor.close();
    setNewItem("");
    setTranscript(null);
    return true;
  }, [session]);
  useImperativeHandle(props.workspaceRef, () => ({
    current: () => !!session?.controller.current,
    requestLeave: leave,
    hasUnsavedChanges: () => !!session?.editor.draft?.version,
    isEditing: () => !!session?.editor.draft,
    pending: () => !!session?.controller.pending,
    revision: () => session?.controller.revision ?? null,
    snapshot: () => session?.controller.snapshot ?? null,
    selection: () =>
      current && props.active !== false
        ? session.editor.selection()
        : undefined,
    refresh: async () => {
      await session?.controller.refresh();
    },
    interact: async (capability, params) => {
      if (!session?.controller.current) {
        throw new DOMException("The Notes connection changed.", "AbortError");
      }
      return session.controller.interact(capability, params);
    },
    begin: (kind) => begin(kind, true),
    retire: () => {
      action.current?.abort();
      session?.editor.close();
      session?.controller.retire();
    },
  }));
  const selection =
    current && props.active !== false ? session.editor.selection() : undefined;
  const selectionId = selection?.id;
  const selectionRevision = selection?.revision;
  useEffect(() => {
    props.onSelectionChange?.(
      selectionId && selectionRevision !== undefined
        ? {
            kind: "canonical-note",
            id: selectionId,
            revision: selectionRevision,
          }
        : undefined,
    );
  }, [selectionId, selectionRevision, props.onSelectionChange]);

  const select = useCallback(
    async (id: string) => {
      if (!isActive()) return;
      if (!session?.controller.current || session.editor.draft?.id === id)
        return;
      if (session.editor.draft && !(await leave())) return;
      if (
        !session.controller.current ||
        !isActive() ||
        !session.controller.hasViewNote(id)
      )
        return;
      setTrash(false);
      session.editor.open(id);
      setReview(false);
    },
    [session, leave, isActive],
  );
  const consumedTarget = useRef<string | null>(null);
  const sourceTarget = props.sourceNoteTarget;
  const sourceAvailable =
    !!sourceTarget &&
    !!snapshot?.notes.some((note) => note.id === sourceTarget.id);
  useEffect(() => {
    if (!sourceTarget) {
      consumedTarget.current = null;
      return;
    }
    const token = JSON.stringify([sourceTarget.id, sourceTarget.sequence]);
    if (
      props.active !== false &&
      sourceAvailable &&
      consumedTarget.current !== token
    ) {
      consumedTarget.current = token;
      void select(sourceTarget.id);
    }
  }, [sourceTarget, sourceAvailable, select, props.active]);

  const change = (patch: Parameters<NotesEditor["edit"]>[0]) => {
    if (!session?.controller.current || !isActive()) return;
    session.editor.edit(patch);
    // Each owner edit requests a save. The shared editor coalesces edits during
    // an in-flight write and never retries a failed write on its own.
    void session.editor.save();
  };
  const changeFormat = (
    data: Record<string, NoteJson>,
    kind = draft?.format?.kind ?? "text",
  ) => change({ format: { kind, data: { ...draft?.format?.data, ...data } } });
  const begin = (kind: "text" | "list" = "text", hostCommand = false) => {
    if (!session?.controller.current || busy || (!hostCommand && !isActive()))
      return false;
    if (session.editor.draft?.version) {
      setReview(true);
      return false;
    }
    session.editor.begin(kind);
    setTrash(false);
    setReview(false);
    setNewItem("");
    setTranscript(null);
    return true;
  };
  const reload = async () => {
    if (!session?.controller.current || !isActive()) return;
    const id = session.editor.draft?.id;
    session.editor.close();
    setReview(false);
    setTranscript(null);
    try {
      await session.controller.refresh();
      if (id && session.controller.hasViewNote(id)) session.editor.open(id);
    } catch {
      /* The controller retains the typed error and cached collection. */
    }
  };
  const runPort = async (
    name: Exclude<keyof NotesWorkspacePorts, "dictate">,
  ) => {
    if (!session?.controller.current || portBusy || !isActive()) return;
    const captured = session.editor.draft;
    if (session.editor.draft?.version && !(await session.editor.save())) return;
    const selected = session.editor.draft;
    if (
      !session.controller.current ||
      !isActive() ||
      selected?.token !== captured?.token
    )
      return;
    const note = selected?.id
      ? session.controller.viewNote(selected.id)
      : undefined;
    const port = latest.current.ports?.[name];
    if (!note || !port) return;
    const abort = new AbortController();
    action.current = abort;
    setPortBusy(true);
    try {
      await port(note, abort.signal);
    } catch (cause) {
      if (!abort.signal.aborted && session.controller.current) {
        latest.current.onOperationError?.(cause);
        setNotice(
          name === "readAloud"
            ? "Reading did not finish. The note is unchanged."
            : name === "openSource"
              ? "The source could not be opened. The note is unchanged."
              : name === "draftEvent" || name === "draftReminder"
                ? "The draft could not be opened. Nothing was scheduled."
                : "This note could not be shared. Try again.",
        );
      }
    } finally {
      if (action.current === abort) {
        action.current = null;
        if (session.controller.current) setPortBusy(false);
      }
    }
  };
  const dictate = async () => {
    if (
      !draft ||
      !session ||
      !props.ports?.dictate ||
      portBusy ||
      props.active === false
    )
      return;
    const captured = draft;
    const start = bodyInput.current?.selectionStart ?? draft.body.length;
    const end = bodyInput.current?.selectionEnd ?? start;
    const abort = new AbortController();
    action.current = abort;
    setPortBusy(true);
    try {
      const words = await props.ports.dictate(abort.signal);
      if (abort.signal.aborted || !session.controller.current) return;
      const next = session.editor.draft;
      if (next?.token === captured.token && next.body === captured.body)
        change({
          body: next.body.slice(0, start) + words + next.body.slice(end),
        });
      else {
        setTranscript(words);
        setNotice(
          "The note changed during dictation. Review the transcript before inserting it.",
        );
      }
    } catch (cause) {
      if (!abort.signal.aborted && session.controller.current) {
        latest.current.onOperationError?.(cause);
        setNotice("Dictation did not finish. Try again.");
      }
    } finally {
      if (action.current === abort) {
        action.current = null;
        if (session.controller.current) setPortBusy(false);
      }
    }
  };
  const titleControl = useAgentElement<HTMLInputElement>({
    id: "notes-title",
    role: "text-input",
    group: "notes-editor",
    label: "Title",
  });
  const bodyControl = useAgentElement<HTMLTextAreaElement>({
    id: "notes-body",
    role: "textarea",
    group: "notes-editor",
    label: "Note",
  });
  const fieldItems = items(draft?.format);
  const richText = authoredNoteText(
    draft?.format?.kind === "voice"
      ? { ...draft.format, data: { ...draft.format.data, actions: [] } }
      : draft?.format,
  );
  const list = useMemo(
    () =>
      snapshot
        ? {
            ...snapshot,
            notes: snapshot.notes
              .filter((note) =>
                [reconstructNoteContent(note), authoredNoteText(note.format)]
                  .join("\n")
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .sort(
                (a, b) =>
                  Number(!!b.format?.data.pinned) -
                  Number(!!a.format?.data.pinned),
              ),
          }
        : null,
    [snapshot, query],
  );
  const formatKind = draft?.format?.kind ?? "text";
  const editor =
    draft && session ? (
      <section className="notes-workspace-editor" aria-label="Note editor">
        <div className="notes-workspace-actions">
          <AgentAction
            agentId="notes-back"
            agentLabel="Back to notes"
            agentGroup="notes-editor"
            onClick={() => void leave()}
          >
            Back to notes
          </AgentAction>
          <AgentAction
            agentId="notes-pin"
            agentLabel={draft.format?.data.pinned ? "Unpin" : "Pin"}
            agentGroup="notes-editor"
            onClick={() => changeFormat({ pinned: !draft.format?.data.pinned })}
          >
            {draft.format?.data.pinned ? "Unpin" : "Pin"}
          </AgentAction>
          <AgentAction
            agentId="notes-delete"
            agentLabel="Delete note"
            agentGroup="notes-editor"
            disabled={!draft.id || busy}
            onClick={() => {
              if (draft.id) void session.editor.remove(draft.id);
            }}
          >
            Delete
          </AgentAction>
          {(formatKind === "text" || formatKind === "list") && (
            <AgentAction
              agentId="notes-format"
              agentLabel={
                formatKind === "list" ? "Turn into text" : "Turn into checklist"
              }
              agentGroup="notes-editor"
              onClick={() => {
                if (formatKind === "list")
                  change({
                    body: fieldItems.map(text).join("\n"),
                    format: {
                      kind: "text",
                      data: { ...draft.format?.data, items: [] },
                    },
                  });
                else
                  change({
                    body: "",
                    format: {
                      kind: "list",
                      data: {
                        ...draft.format?.data,
                        items: draft.body
                          .split("\n")
                          .filter((line) => line.trim())
                          .map((t) => ({ t, done: false })),
                      },
                    },
                  });
              }}
            >
              {formatKind === "list" ? "Turn into text" : "Turn into checklist"}
            </AgentAction>
          )}
        </div>
        <label>
          Title
          <input
            {...titleControl.agentProps}
            ref={titleControl.ref}
            value={draft.title}
            onChange={(event) => change({ title: event.target.value })}
          />
        </label>
        {formatKind === "list" ? (
          <fieldset
            aria-label="Checklist"
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            {fieldItems.map((item, index) =>
              record(item) && typeof item.t === "string" ? (
                // Existing authored items have positional identity, not required IDs.
                // biome-ignore lint/suspicious/noArrayIndexKey: Keep an input mounted while its exact text changes.
                <div className="notes-workspace-item" key={index}>
                  <input
                    type="checkbox"
                    aria-label={`${item.done ? "Uncheck" : "Check"} ${item.t || "item"}`}
                    checked={item.done === true}
                    onChange={() =>
                      changeFormat({
                        items: fieldItems.map((entry, i) =>
                          i === index ? { ...item, done: !item.done } : entry,
                        ),
                      })
                    }
                  />
                  <input
                    type="text"
                    aria-label={`Checklist item ${index + 1}`}
                    value={item.t}
                    onChange={(event) =>
                      changeFormat({
                        items: fieldItems.map((entry, i) =>
                          i === index
                            ? { ...item, t: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                  <AgentAction
                    agentId={`notes-remove-item-${index}`}
                    agentLabel={`Remove item ${index + 1}`}
                    agentGroup="notes-editor"
                    onClick={() =>
                      changeFormat({
                        items: fieldItems.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </AgentAction>
                </div>
              ) : null,
            )}
            <form
              className="notes-workspace-item"
              onSubmit={(event) => {
                event.preventDefault();
                if (newItem.trim()) {
                  changeFormat({
                    items: [...fieldItems, { t: newItem, done: false }],
                  });
                  setNewItem("");
                }
              }}
            >
              <input
                type="text"
                aria-label="New checklist item"
                value={newItem}
                onChange={(event) => setNewItem(event.target.value)}
              />
              <AgentAction
                agentId="notes-add-item"
                agentLabel="Add item"
                agentGroup="notes-editor"
                disabled={!newItem.trim()}
                onClick={() => {
                  if (newItem.trim()) {
                    changeFormat({
                      items: [...fieldItems, { t: newItem, done: false }],
                    });
                    setNewItem("");
                  }
                }}
              >
                Add item
              </AgentAction>
            </form>
          </fieldset>
        ) : (
          <label>
            Note
            <textarea
              {...bodyControl.agentProps}
              ref={(element) => {
                bodyInput.current = element;
                bodyControl.ref.current = element;
              }}
              value={draft.body}
              onChange={(event) => change({ body: event.target.value })}
            />
          </label>
        )}
        {(formatKind === "voice" || formatKind === "link") && richText && (
          <section
            className="notes-workspace-rich"
            aria-label={
              formatKind === "voice" ? "Transcript and summary" : "Link clips"
            }
          >
            {richText}
          </section>
        )}
        {formatKind === "voice" &&
          items(draft.format, "actions").length > 0 && (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Action items</legend>
              {items(draft.format, "actions").map((item, index) =>
                record(item) && typeof item.t === "string" ? (
                  // Authored action rows use their stable position; editing done must not remount them.
                  <VoiceAction
                    // biome-ignore lint/suspicious/noArrayIndexKey: Canonical action rows have no required ID.
                    key={index}
                    item={item}
                    index={index}
                    toggle={() =>
                      changeFormat({
                        actions: items(draft.format, "actions").map(
                          (entry, i) =>
                            i === index ? { ...item, done: !item.done } : entry,
                        ),
                      })
                    }
                  />
                ) : null,
              )}
            </fieldset>
          )}
        {formatKind === "link" &&
          typeof draft.format?.data.url === "string" && (
            <p className="notes-workspace-rich">{draft.format.data.url}</p>
          )}
        <div className="notes-workspace-actions">
          {props.ports?.dictate && formatKind === "text" && (
            <AgentAction
              agentId="notes-dictate"
              agentLabel="Dictate"
              agentGroup="notes-editor"
              disabled={portBusy}
              onClick={() => void dictate()}
            >
              Dictate
            </AgentAction>
          )}
          {(
            [
              ["copyText", "Copy text"],
              ["share", "Share"],
              ["exportText", "Export text"],
              ["composeEmail", "Email draft"],
              ["readAloud", "Read aloud"],
              ["openSource", "Open source"],
              ["draftReminder", "Reminder draft"],
              ["draftEvent", "Calendar draft"],
            ] as const
          ).map(([name, label]) =>
            props.ports?.[name] ? (
              <AgentAction
                key={name}
                agentId={`notes-${name}`}
                agentLabel={label}
                agentGroup="notes-editor"
                disabled={portBusy || !draft.id}
                onClick={() => void runPort(name)}
              >
                {label}
              </AgentAction>
            ) : null,
          )}
          {portBusy && (
            <AgentAction
              agentId="notes-cancel-operation"
              agentLabel="Cancel note operation"
              agentGroup="notes-editor"
              onClick={() => action.current?.abort()}
            >
              Cancel
            </AgentAction>
          )}
        </div>
        {transcript !== null && (
          <div className="notes-workspace-message">
            <p>{transcript}</p>
            <AgentAction
              agentId="notes-append-transcript"
              agentLabel="Append reviewed transcript"
              agentGroup="notes-editor"
              onClick={() => {
                change({
                  body: draft.body + (draft.body ? "\n" : "") + transcript,
                });
                setTranscript(null);
              }}
            >
              Append reviewed transcript
            </AgentAction>
          </div>
        )}
      </section>
    ) : null;
  const toolbar = (
    <>
      <style>{styles}</style>
      <div className="notes-workspace-toolbar">
        <input
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <AgentAction
          agentId="notes-new"
          agentLabel="New note"
          agentGroup="notes-toolbar"
          disabled={!snapshot || busy}
          onClick={() => begin()}
        >
          New note
        </AgentAction>
        <AgentAction
          agentId="notes-trash"
          agentLabel={trash ? "Close Trash" : "Open Trash"}
          agentGroup="notes-toolbar"
          disabled={!snapshot || busy}
          onClick={() => {
            if (trash) setTrash(false);
            else
              void leave().then((done) => {
                if (done) setTrash(true);
              });
          }}
        >
          {trash ? "Close Trash" : "Trash"}
        </AgentAction>
        {props.sources
          ?.filter((source) => !source.selected)
          .map((source) => (
            <AgentAction
              key={source.id}
              agentId={`notes-source-${source.id}`}
              agentLabel={source.label}
              agentGroup="notes-toolbar"
              disabled={busy || portBusy}
              onClick={() => {
                if (session?.editor.draft?.version) setReview(true);
                else
                  void source.select().catch((cause) => {
                    latest.current.onOperationError?.(cause);
                    setNotice(
                      "The notes source could not be opened. Try again.",
                    );
                  });
              }}
            >
              {source.label}
            </AgentAction>
          ))}
      </div>
      <p role="status" aria-live="polite">
        {busy
          ? "Saving…"
          : review
            ? "Review unsaved changes."
            : phase === "loading"
              ? "Opening Notes…"
              : ""}
      </p>
      {review && (
        <div className="notes-workspace-message" role="alert">
          Your draft is kept here. Reload the current notes to discard it.
          <AgentAction
            agentId="notes-reload"
            agentLabel={
              draft?.version ? "Discard draft and reload" : "Reload Notes"
            }
            agentGroup="notes-status"
            onClick={() => void reload()}
          >
            {draft?.version ? "Discard draft and reload" : "Reload Notes"}
          </AgentAction>
        </div>
      )}
      {notice && (
        <div className="notes-workspace-message" role="status">
          {notice}
        </div>
      )}
    </>
  );
  return (
    <NotesSurface
      snapshot={list}
      loading={phase === "loading"}
      error={error}
      refresh={async () => {
        await session?.controller.refresh().catch(() => {});
      }}
      sourceNoteTarget={props.sourceNoteTarget}
      toolbar={toolbar}
      editor={trash ? null : editor}
      selectedNoteId={draft?.id}
      onSelect={(id) => void select(id)}
      emptyDescription={
        query
          ? "No notes match this search."
          : "Create a note or ask your assistant to save one."
      }
    >
      {trash ? (
        <section aria-label="Notes Trash">
          <p>Deleted notes are kept here for recovery.</p>
          <ul className="notes-workspace-trash">
            {snapshot?.trash?.map((entry) => (
              <li key={entry.note.id}>
                <span>{entry.note.title || "Untitled"}</span>
                <AgentAction
                  agentId={`notes-restore-${entry.note.id}`}
                  agentLabel={`Restore ${entry.note.title || "note"}`}
                  agentGroup="notes-trash"
                  disabled={busy}
                  onClick={() => void session?.editor.restore(entry.note.id)}
                >
                  Restore
                </AgentAction>
              </li>
            ))}
          </ul>
          {snapshot?.trash?.length ? null : <p>Trash is empty.</p>}
        </section>
      ) : undefined}
    </NotesSurface>
  );
}
