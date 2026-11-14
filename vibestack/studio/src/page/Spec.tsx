// The selected spec: its title and introduction, its stories and rules, each opened, edited, moved and deleted as
// outline events (spec/outline.md). A story whose heading does not start with "Story:" is a group of rules.
import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, Input, cn } from "@repo/ui";
import type { Outline, Rule, Story } from "../../gen/outline.ts";
import { itemsOf, nodeId, nodesOfOutline, ruleKey, storyKey, textBody, type Item } from "../markdown.ts";
import {
  S, addRule, addStory, deleteSpec, doneEditing, editNode, editRule, editStory, failures, find, focusLater, keepMine,
  move, nudge, removeNode, retitle, reviewOf, ruleChanged, soleHeading, specLabel, storyChanged, takeTheirs, toggle, ui, redraw,
  type Working,
} from "./studio.ts";
import { Code, Dot, Icon, IconButton, Markdown, Quint, type Mark } from "./text.tsx";

/** What is being dragged, for the drop targets that accept it. */
export let dragging: { uid: string; kind: "story" | "rule" } | null = null;
type Drop = "before" | "after" | "into" | null;

/** Drag a story or rule, and drop one before or after it, or a rule into a story. */
function useDrag(uid: string, kind: "story" | "rule", accepts: (kind: string) => boolean) {
  const [drop, setDrop] = useState<Drop>(null);
  const [lifted, setLifted] = useState(false);
  return {
    drop, lifted,
    props: {
      draggable: true,
      onDragStart: (e: DragEvent) => { e.stopPropagation(); dragging = { uid, kind }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", uid); setTimeout(() => setLifted(true), 0); },
      onDragEnd: () => { dragging = null; setLifted(false); },
      onDragOver: (e: DragEvent) => {
        if (!dragging || !accepts(dragging.kind) || dragging.uid === uid) return;
        e.preventDefault();
        e.stopPropagation();
        const box = e.currentTarget.getBoundingClientRect();
        setDrop(dragging.kind === "rule" && kind === "story" ? "into" : e.clientY < box.top + box.height / 2 ? "before" : "after");
      },
      onDragLeave: () => setDrop(null),
      onDrop: (e: DragEvent) => {
        if (!dragging || !accepts(dragging.kind)) return;
        e.preventDefault();
        e.stopPropagation();
        const where = drop === "before" ? "before" : "after";
        setDrop(null);
        move(dragging.uid, { uid, where });
      },
    },
  };
}
const DROP: Record<Exclude<Drop, null>, string> = { before: "shadow-[0_-3px_0_var(--primary)]", after: "shadow-[0_3px_0_var(--primary)]", into: "outline-2 outline-dashed outline-primary" };

/** The keys on a focused story or rule: open, edit, delete, and move up or down. */
function keys(e: KeyboardEvent, id: string) {
  if (e.target !== e.currentTarget) return;
  if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); nudge(id, -1); }
  else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); nudge(id, 1); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(id); focusLater(`[data-uid="${id}"] > [data-row]`); }
  else if (e.key === "e") { e.preventDefault(); editNode(id); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeNode(id); }
}

/** A story's or rule's line: grip, chevron, title, marks and actions. */
function Row({ id, title, unique, open, editing, children, actions }: { id: string; title: string; unique: boolean; open: boolean; editing: boolean; children?: ReactNode; actions: ReactNode }) {
  return (
    <div data-row tabIndex={0} onKeyDown={(e) => keys(e, id)} className="group flex min-h-9 items-center gap-2 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <span aria-hidden className="cursor-grab text-muted-foreground"><Icon name="grip" /></span>
      <span aria-hidden onClick={() => toggle(id)} className={cn("text-muted-foreground transition-transform duration-fast", open && "rotate-90")}><Icon name="chev" /></span>
      <span onClick={() => toggle(id)} onDoubleClick={() => editNode(id)} className={cn("min-w-0 flex-1 cursor-pointer", !unique && "text-destructive")}>{title.trim() || "Untitled"}</span>
      {children}
      <span className={cn("flex gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100", editing && "opacity-100")}>{actions}</span>
    </div>
  );
}

/** "Move to…": every story of every spec for a rule, every other spec for a story. Keyboard users' drag and drop. */
function MoveMenu({ id, kind }: { id: string; kind: "story" | "rule" }) {
  const home = find(id)?.spec.file;
  const specs = S.specs.filter((s) => !s.deleted);
  return (
    <select title="Move to…" aria-label="Move to" value="" onClick={(e) => e.stopPropagation()}
      className="w-6 cursor-pointer appearance-none rounded-sm bg-transparent text-center text-muted-foreground hover:bg-accent"
      onChange={(e) => { const [type, value] = e.target.value.split("|"); move(id, type === "spec" ? { spec: value } : { uid: value, where: "after" }); }}>
      <option value="" disabled>⇅</option>
      {kind === "rule"
        ? specs.map((spec) => <optgroup key={spec.file} label={specLabel(spec.file)}>{spec.outline.stories.map((s) => <option key={s.id} value={`story|${ui(spec.file, s.id)}`}>{s.title.trim() || "(untitled)"}</option>)}</optgroup>)
        : specs.filter((s) => s.file !== home).map((spec) => <option key={spec.file} value={`spec|${spec.file}`}>to {specLabel(spec.file)}</option>)}
    </select>
  );
}

/** A text box that grows with what it holds. */
function TextBox({ value, onChange, code = false, placeholder, label }: { value: string; onChange: (v: string) => void; code?: boolean; placeholder?: string; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const ta = ref.current!; ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; }, [value]);
  return (
    <textarea ref={ref} value={value} rows={1} spellCheck={!code} placeholder={placeholder} aria-label={label}
      className={cn("min-h-10 w-full resize-y overflow-hidden rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", code && "bg-muted font-mono text-xs leading-relaxed")}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (!code || e.key !== "Tab" || e.shiftKey) return;
        e.preventDefault();
        const ta = e.currentTarget;
        ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
        onChange(ta.value);
      }} />
  );
}
const Heading = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
  <Input data-heading value={value} aria-label={label} placeholder={label} invalid={!value.trim()} className="font-semibold"
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest("[data-edit]")?.querySelector("textarea")?.focus(); } }} />
);
const Done = ({ id, children }: { id: string; children?: ReactNode }) => (
  <div className="flex items-center gap-2">{children}<span className="flex-1" /><Button variant="outline" size="sm" onClick={() => doneEditing(id)}><Icon name="check" />Done</Button></div>
);
const Status = ({ mark, children }: { mark: "review" | "bad"; children: ReactNode }) => (
  <div className={cn("text-xs", mark === "review" ? "text-warn" : "text-destructive")}>{children}</div>
);

/** The mark a story or rule carries: failing a check, waiting for review, or unpublished. */
const markOf = (changed: boolean, fails: string[] | undefined, review: string | undefined): [Mark, string] =>
  fails?.length ? ["bad", fails.join("\n")] : review ? ["review", review] : changed ? ["dirty", "unpublished change"] : ["", ""];

function StoryCard({ spec, story, s, byKey }: { spec: Working; story: Story; s: number; byKey: Map<string, string[]> }) {
  const id = ui(spec.file, story.id);
  const review = reviewOf(spec, storyKey(story.title));
  const changed = storyChanged(spec, story, s);
  const open = S.open.has(id);
  const editing = S.editing.has(id);
  const [mark, label] = markOf(changed, undefined, review);
  const drag = useDrag(id, "story", (k) => k === "story" || k === "rule");
  return (
    <section data-uid={id} aria-label={story.title || "Rules"} {...drag.props}
      className={cn("mb-3 rounded-lg border border-border bg-card", changed && "shadow-[inset_3px_0_0_var(--primary)]", drag.lifted && "opacity-40", drag.drop && DROP[drag.drop])}>
      <div className={cn("font-semibold", !story.title.startsWith("Story:") && "text-muted-foreground")}>
        <Row id={id} title={story.title} unique={soleHeading(spec.outline.stories.map((x) => x.title.trim()), story.title.trim())} open={open} editing={editing}
          actions={<>
            <IconButton name="edit" label="Edit story" onClick={() => editNode(id)} />
            <IconButton name="plus" label="Add rule" onClick={() => addRule(spec, s)} />
            <MoveMenu id={id} kind="story" />
            <IconButton name="trash" label="Delete story and its rules" danger onClick={() => removeNode(id)} />
          </>}>
          <span title="rules" className="text-xs font-normal text-muted-foreground tabular-nums">{story.rules.length}</span>
          <Dot mark={mark} label={label} />
        </Row>
      </div>
      {open && editing ? (
        <div data-edit className="flex flex-col gap-2 px-3 pb-3 pl-13">
          <Heading value={story.title} label="Story: As a … I want …" onChange={(v) => editStory(id, v, story.body)} />
          <TextBox value={story.body.trim()} label="Story text" placeholder="> As a …, I want …, so that …" onChange={(v) => editStory(id, story.title, textBody(v))} />
          {review && <Status mark="review">{review}</Status>}
          <Done id={id} />
        </div>
      ) : open && story.body.trim() ? (
        <div onDoubleClick={() => editNode(id)} className="px-4 pb-3 pl-13 text-muted-foreground"><Markdown text={story.body} file={spec.file} /></div>
      ) : null}
      {open && review && !editing && <div className="px-4 pb-3 pl-13"><Status mark="review">{review}</Status></div>}
      {open && (
        <ul className="m-0 flex list-none flex-col gap-0.5 px-3 pb-3 pl-9">
          {story.rules.map((r, j) => <RuleItem key={r.id} spec={spec} story={story} rule={r} r={j} byKey={byKey} />)}
          <li className="pt-1"><Button variant="ghost" size="sm" className="border border-dashed border-border text-muted-foreground" onClick={() => addRule(spec, s)}><Icon name="plus" />Rule</Button></li>
        </ul>
      )}
    </section>
  );
}

function RuleItem({ spec, story, rule, r, byKey }: { spec: Working; story: Story; rule: Rule; r: number; byKey: Map<string, string[]> }) {
  const id = ui(spec.file, rule.id);
  const key = ruleKey(story.title, rule.title);
  const review = reviewOf(spec, key);
  const fails = byKey.get(nodeId(spec.file, key));
  const changed = ruleChanged(spec, story, rule, r);
  const open = S.open.has(id);
  const editing = S.editing.has(id);
  const [mark, label] = markOf(changed, fails, review);
  const items = itemsOf(rule.body);
  const drag = useDrag(id, "rule", (k) => k === "rule");
  return (
    <li data-uid={id} {...drag.props} onDoubleClick={(e) => { if (!editing && (e.target as Element).closest("[data-body]")) editNode(id); }}
      className={cn("rounded-md border border-transparent hover:bg-accent/50", open && "border-border bg-card hover:bg-card", changed && "shadow-[inset_3px_0_0_var(--primary)]", drag.lifted && "opacity-40", drag.drop && DROP[drag.drop])}>
      <Row id={id} title={rule.title} unique={soleHeading(story.rules.map((x) => x.title.trim()), rule.title.trim())} open={open} editing={editing}
        actions={<>
          <IconButton name="edit" label="Edit rule" onClick={() => editNode(id)} />
          <MoveMenu id={id} kind="rule" />
          <IconButton name="trash" label="Delete rule" danger onClick={() => removeNode(id)} />
        </>}>
        {!items.some((i) => i.quint) && <span role="img" aria-label="no Quint" title="no Quint" className="font-mono text-xs text-warn">∅</span>}
        <Dot mark={mark} label={label} />
      </Row>
      {open && (editing ? <RuleEditor id={id} rule={rule} /> : (
        <div data-body className="flex flex-col gap-3 px-3 pb-3 pl-13">
          {items.map((i) => (i.quint ? <Quint key={`q${i.text}`} code={i.text} /> : <Markdown key={`p${i.text}`} text={i.text} file={spec.file} />))}
          {review && <Status mark="review">{review}</Status>}
          {fails?.map((f) => <Status key={f} mark="bad">{f}</Status>)}
        </div>
      ))}
    </li>
  );
}

const blockKeys = new WeakMap<Item, number>();
let blocks = 0;

/** A rule's heading, prose and Quint blocks being edited; each change is one `editRule` event (spec/outline.md). */
function RuleEditor({ id, rule }: { id: string; rule: Rule }) {
  if (!S.items.has(id)) S.items.set(id, itemsOf(rule.body).length ? itemsOf(rule.body) : [{ quint: false, text: "" }]);
  const items = S.items.get(id)!;
  const set = (next: Item[]) => { S.items.set(id, next); editRule(id, rule.title, next); redraw(); };
  /** Each block keeps its key while it is edited and moved, so its text box keeps the caret. */
  const keyOf = (item: Item) => { if (!blockKeys.has(item)) blockKeys.set(item, ++blocks); return blockKeys.get(item)!; };
  return (
    <div data-edit className="flex flex-col gap-2 px-3 pb-3 pl-13">
      <Heading value={rule.title} label="One checkable sentence" onChange={(v) => editRule(id, v)} />
      {items.map((item, k) => (
        <div key={keyOf(item)} className="flex items-start gap-1">
          <TextBox value={item.text} code={item.quint} label={item.quint ? "Quint" : "Prose"} placeholder={item.quint ? "pure def …" : "Prose (optional)"}
            onChange={(v) => { item.text = v; set([...items]); }} />
          <div className="flex flex-col gap-0.5 pt-0.5">
            {k > 0 && <IconButton name="up" label="Move up" onClick={() => set([...items.slice(0, k - 1), item, items[k - 1], ...items.slice(k + 1)])} />}
            <IconButton name="close" label="Remove" danger onClick={() => set(items.filter((_, i) => i !== k))} />
          </div>
        </div>
      ))}
      <Done id={id}>
        <Button variant="outline" size="sm" onClick={() => set([...items, { quint: false, text: "" }])}><Icon name="plus" />Prose</Button>
        <Button variant="outline" size="sm" onClick={() => { set([...items, { quint: true, text: "" }]); focusLater(`[data-uid="${id}"] textarea[aria-label="Quint"]:last-of-type`); }}><Icon name="plus" />Quint</Button>
      </Done>
    </div>
  );
}

/** A spec changed on disk while this page edits it: what changed there, so that keeping these edits is a choice. */
function Conflict({ spec }: { spec: Working }) {
  const fresh = S.snap!.specs.find((s) => s.file === spec.file);
  const titles = (o: Outline) => new Map(nodesOfOutline(spec.file, o).map((n) => [n.key, (n.rule ?? n.story).body]));
  const was = titles(spec.was);
  const now = fresh ? titles(fresh.outline) : new Map<string, string>();
  const there = [...now].filter(([k, v]) => was.get(k) !== v).map(([k]) => k).concat([...was.keys()].filter((k) => !now.has(k)).map((k) => `${k} (removed)`));
  return (
    <Banner tone="warn">
      <span className="flex-1">{fresh && there.length ? there.map((k) => k.replace(/^## /, "")).join(" · ") : `${spec.file}${fresh ? "" : " (removed)"}`}</span>
      <Button variant="outline" size="sm" onClick={() => keepMine(spec.file)}>Keep mine</Button>
      <Button variant="outline" size="sm" onClick={() => takeTheirs(spec.file)}>Take disk</Button>
    </Banner>
  );
}
const Banner = ({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) => (
  <div className={cn("mb-4 flex items-center gap-3 rounded-lg border px-4 py-3", tone === "warn" ? "border-warn" : "border-destructive")}>{children}</div>
);

export function Spec({ spec }: { spec: Working }) {
  const { byKey, bySpec } = failures();
  const o = spec.outline;
  const headId = ui(spec.file, "head");
  const specFails = bySpec.get(spec.file)?.filter((r) => !/"[^"]+" \(spec\//.test(`${r.summary}\n${r.detail}`));
  return (
    <div className="mx-auto max-w-230">
      {S.conflicts.includes(spec.file) && <Conflict spec={spec} />}
      {S.snap?.problem && <Code className="mb-4 border-destructive whitespace-pre-wrap text-destructive">{S.snap.problem}</Code>}
      {!!specFails?.length && <Banner tone="bad"><span className="flex-1 whitespace-pre-wrap">{specFails.map((r) => `${r.stage}: ${r.summary}`).join("\n")}</span></Banner>}
      {spec.deleted && <Banner tone="bad"><span className="flex-1">Deleted on publish.</span><Button variant="outline" size="sm" onClick={() => deleteSpec(spec, false)}>Keep</Button></Banner>}
      <div data-uid={headId} className="mb-6">
        {S.editing.has(headId) ? (
          <div data-edit className="flex flex-col gap-2">
            <Heading value={o.title} label="Title" onChange={(v) => retitle(spec, v, o.body)} />
            <TextBox value={o.body.trim()} label="What the application is for" onChange={(v) => retitle(spec, o.title, v)} />
            <Done id={headId} />
          </div>
        ) : (
          <>
            <h1 onDoubleClick={() => editNode(headId)} className="mb-2 flex items-center gap-2 text-2xl font-semibold">
              {o.title || specLabel(spec.file)}<IconButton name="edit" label="Edit title and introduction" onClick={() => editNode(headId)} />
            </h1>
            {o.body.trim() && <Markdown text={o.body} file={spec.file} className="text-muted-foreground" />}
          </>
        )}
      </div>
      {o.stories.map((s, i) => <StoryCard key={s.id} spec={spec} story={s} s={i} byKey={byKey} />)}
      <Button variant="ghost" size="sm" className="mt-3 border border-dashed border-border text-muted-foreground" onClick={() => addStory(spec)}><Icon name="plus" />Story</Button>
    </div>
  );
}

