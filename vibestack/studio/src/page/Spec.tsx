// The selected spec: its title and introduction, Model & UI summary strip, scannable stories with trace strips,
// in-place inline editing (spec/outline.md), rule-level component backlinks, and on-demand Component Peek drawer.
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Alert, Button, Input, Textarea, cn, focusRing } from "@repo/ui";
import type { Outline, Rule, Story } from "../../gen/outline.ts";
import { itemsOf, nodeId, nodesOfOutline, ruleKey, storyKey, textBody, type Item } from "../markdown.ts";
import type { RuleMeta, RuleRole, SpecModelGraph, StoryMeta } from "../graph.ts";
import type { Component } from "../../../stories/emit.ts";
import {
  S, addRule, addStory, deleteSpec, doneEditing, editNode, editRule, editStory, failures, find, focusLater, graphOf,
  keepMine, move, nudge, openComponent, openStateFocus, peekComponent, quoteBody, redraw, removeNode, retitle, reveal,
  reviewCount, reviewOf, ruleChanged, setView, soleHeading, specLabel, storyChanged, stripQuote, takeTheirs, toggle,
  ui, type Working,
} from "./studio.ts";
import { Code, Dot, Icon, IconButton, InlineMarkdown, Markdown, Quint, type Mark } from "./text.tsx";
import type { Result } from "../../../pipeline.ts";

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
const DROP: Record<Exclude<Drop, null>, string> = { before: "border-t-2 border-t-primary", after: "border-b-2 border-b-primary", into: "outline-2 outline-dashed outline-primary" };

const GLYPH: Record<RuleRole, { symbol: string; title: string; color: string }> = {
  transition: { symbol: "→", title: "Transition", color: "text-primary" },
  always: { symbol: "∀", title: "Invariant (always)", color: "text-info" },
  step: { symbol: "⊢", title: "Step rule", color: "text-warn" },
  sometimes: { symbol: "⚑", title: "Reachability goal (sometimes)", color: "text-ok" },
  leadsTo: { symbol: "↝", title: "Liveness (leadsTo)", color: "text-warn" },
  law: { symbol: "≡", title: "Law", color: "text-info" },
  refines: { symbol: "≡", title: "Refinement", color: "text-info" },
  domain: { symbol: "◇", title: "Domain definition", color: "text-muted-foreground" },
  helper: { symbol: "◇", title: "Helper / view", color: "text-muted-foreground" },
};

const RuleGlyph = ({ role }: { role: RuleRole | undefined }) => {
  const g = GLYPH[role ?? "domain"];
  return <span aria-hidden title={g.title} className={cn("w-4 flex-none text-center font-mono text-xs font-semibold", g.color)}>{g.symbol}</span>;
};

/** The keys on a focused story or rule, beside opening it: move up or down with Alt, delete with Ctrl or ⌘. */
function keys(e: KeyboardEvent, id: string) {
  if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); nudge(id, -1); }
  else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); nudge(id, 1); }
  else if ((e.metaKey || e.ctrlKey) && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeNode(id); }
}

/** "Move to…": every story of every spec for a rule, every other spec for a story. Keyboard users' drag and drop. */
function MoveMenu({ id, kind }: { id: string; kind: "story" | "rule" }) {
  const home = find(id)?.spec.file;
  const specs = S.specs.filter((s) => !s.deleted);
  return (
    <select title="Move to…" aria-label="Move to" value="" onClick={(e) => e.stopPropagation()}
      className="h-6 cursor-pointer rounded-sm bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent"
      onChange={(e) => { const [type, value] = e.target.value.split("|"); move(id, type === "spec" ? { spec: value } : { uid: value, where: "after" }); }}>
      <option value="" disabled>Move ▾</option>
      {kind === "rule"
        ? specs.map((spec) => <optgroup key={spec.file} label={specLabel(spec.file)}>{spec.outline.stories.map((s) => <option key={s.id} value={`story|${ui(spec.file, s.id)}`}>{s.title.trim() || "(untitled)"}</option>)}</optgroup>)
        : specs.filter((s) => s.file !== home).map((spec) => <option key={spec.file} value={`spec|${spec.file}`}>to {specLabel(spec.file)}</option>)}
    </select>
  );
}

/** A text box that grows with what it holds; in code, Tab indents. */
const TextBox = ({ value, onChange, code = false, placeholder, label, className }: { value: string; onChange: (v: string) => void; code?: boolean; placeholder?: string; label: string; className?: string }) => (
  <Textarea value={value} rows={1} spellCheck={!code} placeholder={placeholder} aria-label={label}
    className={cn("min-h-10", code && "rounded-none border-0 bg-muted font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0", className)}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => {
      if (!code || e.key !== "Tab" || e.shiftKey) return;
      e.preventDefault();
      const ta = e.currentTarget;
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      onChange(ta.value);
    }} />
);

const Status = ({ mark, children }: { mark: "review" | "bad"; children: ReactNode }) => (
  <div className={cn("text-xs", mark === "review" ? "text-warn" : "text-destructive")}>{children}</div>
);

/** A failing check result: its stage and summary, and what it found, such as a counterexample trace. */
const Failure = ({ r }: { r: Result }) => (
  <div className="flex flex-col gap-1">
    <Status mark="bad">{r.stage}: {r.summary}</Status>
    {r.detail && <Code className="max-h-80">{r.detail}</Code>}
  </div>
);

/** The mark a story or rule carries: failing a check, waiting for review, or unpublished. */
const markOf = (changed: boolean, fails: Result[] | undefined, review: string | undefined): [Mark, string] =>
  fails?.length ? ["bad", fails.map((r) => `${r.stage}: ${r.summary}`).join("\n")] : review ? ["review", review] : changed ? ["dirty", "unpublished change"] : ["", ""];

/** Quiet Model & UI Summary Strip beneath the spec title and intro. */
function ModelSummaryStrip({ spec, graph, failingCount }: { spec: Working; graph: SpecModelGraph | undefined; failingCount: number }) {
  if (!graph) return null;
  const hasContent = graph.nodes.length > 0 || graph.roles.length > 0 || graph.components.length > 0 || graph.imports.length > 0;
  if (!hasContent) return null;
  const review = reviewCount(spec.file);
  const totalRules = spec.outline.stories.reduce((n, s) => n + s.rules.length, 0);
  const verdict = S.snap?.session.verdict;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2 text-xs">
      {graph.nodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-muted-foreground">{graph.projectionKind === "projected" ? "State" : "States"}</span>
          {graph.nodes.map((n) => (
            <button key={n.id} type="button" onClick={() => openStateFocus(spec.file, { node: n.id })}
              className={cn(focusRing, "rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground hover:bg-accent hover:text-primary")}>
              {n.label}
            </button>
          ))}
        </div>
      )}
      {graph.roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-muted-foreground">Roles</span>
          {graph.roles.map((role) => <span key={role} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">{role}</span>)}
        </div>
      )}
      {graph.components.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-muted-foreground">Rendered by</span>
          {graph.components.map((c) => (
            <button key={c.id} type="button" onClick={() => peekComponent(c.name)}
              className={cn(focusRing, "rounded-sm px-1.5 py-0.5 font-medium transition-colors duration-fast",
                S.peekComponent === c.name ? "bg-accent text-primary" : "bg-muted text-primary hover:bg-accent")}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      {graph.nodes.length === 0 && graph.imports.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-muted-foreground">Imports</span>
          {graph.imports.map((imp) => <span key={imp} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">{imp}</span>)}
        </div>
      )}
      <span className="ml-auto font-medium">
        {failingCount > 0 ? <span className="text-destructive">✗ {failingCount} failing</span>
          : review > 0 ? <span className="text-warn">{review} to review</span>
          : verdict === "Green" && totalRules > 0 ? <span className="text-ok">✓ {totalRules} rules proved</span>
          : totalRules > 0 ? <span className="text-muted-foreground">{totalRules} rules</span> : null}
      </span>
    </div>
  );
}

/** Quiet Story Trace Strip summarizing state path, transitions, rule counts, tests, and review/proof status. */
function StoryTraceStrip({ spec, meta, review }: { spec: Working; meta: StoryMeta | undefined; review: string | undefined }) {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.counts.invariants) parts.push(`${meta.counts.invariants} invariant${meta.counts.invariants === 1 ? "" : "s"}`);
  if (meta.counts.goals) parts.push(`${meta.counts.goals} goal${meta.counts.goals === 1 ? "" : "s"}`);
  if (meta.counts.steps) parts.push(`${meta.counts.steps} step${meta.counts.steps === 1 ? "" : "s"}`);
  if (meta.counts.liveness) parts.push(`${meta.counts.liveness} liveness`);
  const hasData = meta.states.length > 0 || meta.transitions.length > 0 || parts.length > 0 || meta.tests.length > 0 || meta.components.length > 0;
  if (!hasData) return null;

  return (
    <div className="mx-3 mb-2 ml-9 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {meta.states.length > 0 && (
        <button type="button" onClick={() => openStateFocus(spec.file, { node: meta.states[0] })}
          className={cn(focusRing, "rounded-sm font-medium text-primary hover:underline")}>
          {meta.states.join(" → ")} ↗
        </button>
      )}
      {meta.transitions.length > 0 && (
        <>
          {meta.states.length > 0 && <span aria-hidden>·</span>}
          <span className="flex flex-wrap items-center gap-1">
            {meta.transitions.map((t, i) => (
              <span key={t} className="flex items-center gap-1">
                {i > 0 && <span>,</span>}
                <button type="button" onClick={() => openStateFocus(spec.file, { edge: t })}
                  className={cn(focusRing, "rounded-sm font-mono text-foreground hover:text-primary hover:underline")}>
                  {t}
                </button>
              </span>
            ))}
          </span>
        </>
      )}
      {parts.length > 0 && (
        <>
          {(meta.states.length > 0 || meta.transitions.length > 0) && <span aria-hidden>·</span>}
          <span>{parts.join(" · ")}</span>
        </>
      )}
      {meta.tests.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>Tests: <span className="font-mono text-foreground">{meta.tests.map((t) => t.split("/").pop()).join(", ")}</span></span>
        </>
      )}
      {review && <span className="ml-auto text-warn">{review}</span>}
    </div>
  );
}

/** True in-place story editor (replaces the story heading and narrative without duplicating a header row). */
function StoryEditor({ id, story, review }: { id: string; story: Story; review: string | undefined }) {
  const [draftBody, setDraftBody] = useState(() => stripQuote(story.body));
  const useQuote = story.title.startsWith("Story:") || story.body.trim().startsWith(">");
  return (
    <div data-edit className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Input data-heading value={story.title} aria-label="Story: As a … I want …" placeholder="Story: As a … I want …" invalid={!story.title.trim()}
          className="h-9 flex-1 border-transparent bg-transparent px-1.5 text-base font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
          onChange={(e) => editStory(id, e.target.value, story.body)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest("[data-edit]")?.querySelector("textarea")?.focus(); } }} />
        <Button variant="outline" size="sm" onClick={() => doneEditing(id)}><Icon name="check" />Done</Button>
      </div>
      <TextBox value={draftBody} label="Story text" placeholder="As a …, I want …, so that …"
        className="border-transparent bg-muted/50 px-2.5 py-2 text-sm shadow-none focus-visible:border-input focus-visible:bg-background"
        onChange={(v) => { setDraftBody(v); editStory(id, story.title, useQuote ? quoteBody(v) : textBody(v)); }} />
      {review && <Status mark="review">{review}</Status>}
    </div>
  );
}

function StoryCard({ spec, story, s, byKey, graph }: { spec: Working; story: Story; s: number; byKey: Map<string, Result[]>; graph: SpecModelGraph | undefined }) {
  const id = ui(spec.file, story.id);
  const key = storyKey(story.title);
  const review = reviewOf(spec, key);
  const changed = storyChanged(spec, story, s);
  const open = S.open.has(id);
  const editing = S.editing.has(id);
  const [mark, label] = markOf(changed, undefined, review);
  const drag = useDrag(id, "story", (k) => k === "story" || k === "rule");
  const unique = soleHeading(spec.outline.stories.map((x) => x.title.trim()), story.title.trim());
  const storyMeta = graph?.stories[key];

  return (
    <section data-uid={id} aria-label={story.title || "Rules"} {...drag.props}
      className={cn("mb-4 rounded-lg border border-border bg-card", (changed || editing) && "border-l-4 border-l-primary", drag.lifted && "opacity-40", drag.drop && DROP[drag.drop])}>
      {editing ? (
        <StoryEditor id={id} story={story} review={review} />
      ) : (
        <>
          <div className="group flex min-h-10 items-center gap-2 px-2.5 py-1.5">
            <span aria-hidden className="cursor-grab text-muted-foreground"><Icon name="grip" /></span>
            <button data-row type="button" aria-expanded={open} onClick={() => toggle(id)} onDoubleClick={() => editNode(id)} onKeyDown={(e) => keys(e, id)}
              className={cn(focusRing, "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-base font-semibold",
                !story.title.startsWith("Story:") && "text-muted-foreground", !unique && "text-destructive")}>
              <Icon name="chev" className={cn("text-muted-foreground transition-transform duration-fast", open && "rotate-90")} />
              <span className="truncate">{story.title.trim() || "Untitled"}</span>
            </button>
            <span title="rules" className="text-xs text-muted-foreground tabular-nums">{story.rules.length} {story.rules.length === 1 ? "rule" : "rules"}</span>
            <Dot mark={mark} label={label} />
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
              <IconButton name="edit" label="Edit story" onClick={() => editNode(id)} />
              <IconButton name="plus" label="Add rule" onClick={() => addRule(spec, s)} />
              <MoveMenu id={id} kind="story" />
              <IconButton name="trash" label="Delete story and its rules" danger onClick={() => removeNode(id)} />
            </span>
          </div>
          {story.body.trim() && (
            <div onDoubleClick={() => editNode(id)} className="px-4 pb-2 pl-9 text-sm text-muted-foreground">
              <Markdown text={story.body} file={spec.file} />
            </div>
          )}
          <StoryTraceStrip spec={spec} meta={storyMeta} review={review} />
        </>
      )}
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1.5 border-t border-border/60 px-3 pt-2.5 pb-3">
          {story.rules.map((r, j) => <RuleItem key={r.id} spec={spec} story={story} rule={r} r={j} byKey={byKey} ruleMeta={graph?.rules[ruleKey(story.title, r.title)]} />)}
          <li className="pt-1"><Button variant="ghost" size="sm" className="border border-dashed border-border text-muted-foreground" onClick={() => addRule(spec, s)}><Icon name="plus" />Rule</Button></li>
        </ul>
      )}
    </section>
  );
}

function RuleItem({ spec, story, rule, r, byKey, ruleMeta }: { spec: Working; story: Story; rule: Rule; r: number; byKey: Map<string, Result[]>; ruleMeta: RuleMeta | undefined }) {
  const id = ui(spec.file, rule.id);
  const key = ruleKey(story.title, rule.title);
  const review = reviewOf(spec, key);
  const fails = byKey.get(nodeId(spec.file, key));
  const changed = ruleChanged(spec, story, rule, r);
  const expanded = S.open.has(id);
  const editing = S.editing.has(id);
  const [mark, label] = markOf(changed, fails, review);
  const items = itemsOf(rule.body);
  const drag = useDrag(id, "rule", (k) => k === "rule");
  const unique = soleHeading(story.rules.map((x) => x.title.trim()), rule.title.trim());
  const showQuint = S.density === "quint" || expanded;
  const visibleItems = items.filter((i) => !i.quint || showQuint);

  if (editing) {
    return (
      <li data-uid={id} className="rounded-md border border-primary/40 border-l-4 border-l-primary bg-card p-3">
        <RuleEditor id={id} rule={rule} role={ruleMeta?.role} />
      </li>
    );
  }

  const transitionHint = ruleMeta?.transition
    ? [ruleMeta.transition.from && ruleMeta.transition.to ? `${ruleMeta.transition.from} → ${ruleMeta.transition.to}` : ruleMeta.transition.name, ruleMeta.transition.sender].filter(Boolean).join(" · ")
    : undefined;

  return (
    <li data-uid={id} {...drag.props} onDoubleClick={(e) => { if ((e.target as Element).closest("[data-body]")) editNode(id); }}
      className={cn("rounded-md border border-border/60 bg-background/40 transition-colors duration-fast hover:border-border", changed && "border-l-4 border-l-primary", drag.lifted && "opacity-40", drag.drop && DROP[drag.drop])}>
      <div className="group flex min-h-9 items-center gap-2 px-2.5 py-1.5">
        <span aria-hidden className="cursor-grab text-muted-foreground opacity-50 group-hover:opacity-100"><Icon name="grip" className="size-3.5" /></span>
        <RuleGlyph role={ruleMeta?.role} />
        <button data-row type="button" aria-expanded={showQuint} onClick={() => toggle(id)} onDoubleClick={() => editNode(id)} onKeyDown={(e) => keys(e, id)}
          className={cn(focusRing, "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm font-medium", !unique && "text-destructive")}>
          <span className="min-w-0 flex-1">{rule.title.trim() || "Untitled"}</span>
        </button>
        {!showQuint && ruleMeta?.exprPreview && (
          <code className="hidden max-w-60 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground lg:inline">{ruleMeta.exprPreview}</code>
        )}
        {transitionHint && (
          <button type="button" onClick={() => openStateFocus(spec.file, { edge: ruleMeta?.transition?.name })}
            className={cn(focusRing, "hidden rounded-sm font-mono text-xs text-muted-foreground hover:text-primary sm:inline")}>
            {transitionHint}
          </button>
        )}
        {!items.some((i) => i.quint) && <span role="img" aria-label="no Quint" title="no Quint" className="font-mono text-xs text-warn">∅</span>}
        <Dot mark={mark} label={label} />
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton name="edit" label="Edit rule" onClick={() => editNode(id)} />
          <MoveMenu id={id} kind="rule" />
          <IconButton name="trash" label="Delete rule" danger onClick={() => removeNode(id)} />
        </span>
      </div>

      {Boolean(visibleItems.length > 0 || review || fails?.length || ruleMeta?.components.length) && (
        <div data-body className="flex flex-col gap-2 px-3 pb-2.5 pl-11">
          {visibleItems.map((i) => (i.quint ? <Quint key={`q${i.text}`} code={i.text} /> : <Markdown key={`p${i.text}`} text={i.text} file={spec.file} className="text-sm text-muted-foreground" />))}
          {ruleMeta && ruleMeta.components.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
              <span>Used by</span>
              {ruleMeta.components.map((c) => (
                <button key={c.id} type="button" onClick={() => peekComponent(c.name)}
                  className={cn(focusRing, "rounded-sm px-1.5 py-0.5 font-mono text-xs transition-colors duration-fast",
                    S.peekComponent === c.name ? "bg-accent text-primary" : "bg-muted text-primary hover:bg-accent")}>
                  {c.name}{c.symbols.length ? ` (${c.symbols.join(", ")})` : ""}
                </button>
              ))}
            </div>
          )}
          {review && <Status mark="review">{review}</Status>}
          {fails?.map((f) => <Failure key={`${f.stage} ${f.summary}`} r={f} />)}
        </div>
      )}
    </li>
  );
}

const blockKeys = new WeakMap<Item, number>();
let blocks = 0;

/** True in-place rule editor inside a single primary-accented card, with integrated Quint micro-toolbar. */
function RuleEditor({ id, rule, role }: { id: string; rule: Rule; role: RuleRole | undefined }) {
  if (!S.items.has(id)) S.items.set(id, itemsOf(rule.body).length ? itemsOf(rule.body) : [{ quint: false, text: "" }]);
  const items = S.items.get(id)!;
  const set = (next: Item[]) => { S.items.set(id, next); editRule(id, rule.title, next); redraw(); };
  const keyOf = (item: Item) => { if (!blockKeys.has(item)) blockKeys.set(item, ++blocks); return blockKeys.get(item)!; };
  return (
    <div data-edit className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <RuleGlyph role={role} />
        <Input data-heading value={rule.title} aria-label="One checkable sentence" placeholder="One checkable sentence" invalid={!rule.title.trim()}
          className="h-8 flex-1 border-transparent bg-transparent px-1.5 text-sm font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
          onChange={(e) => editRule(id, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest("[data-edit]")?.querySelector("textarea")?.focus(); } }} />
        <Button variant="outline" size="sm" onClick={() => doneEditing(id)}><Icon name="check" />Done</Button>
      </div>
      {items.map((item, k) => (
        <div key={keyOf(item)} className={item.quint ? "overflow-hidden rounded-md border border-border bg-muted" : "group relative flex flex-col gap-1"}>
          <div className={cn("flex items-center justify-between text-xs text-muted-foreground", item.quint && "border-b border-border px-2.5 py-1")}>
            <span className={cn(item.quint && "font-mono")}>{item.quint ? "Quint" : "Prose"}</span>
            <div className={cn("flex items-center gap-1", !item.quint && "opacity-70 group-focus-within:opacity-100 group-hover:opacity-100")}>
              {k > 0 && <IconButton name="up" label="Move up" onClick={() => set([...items.slice(0, k - 1), item, items[k - 1], ...items.slice(k + 1)])} />}
              <IconButton name="close" label="Remove" danger onClick={() => set(items.filter((_, i) => i !== k))} />
            </div>
          </div>
          <TextBox value={item.text} code={item.quint} label={item.quint ? "Quint" : "Prose"} placeholder={item.quint ? "pure def …" : "Prose (optional)"}
            onChange={(v) => { item.text = v; set([...items]); }} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => set([...items, { quint: false, text: "" }])}><Icon name="plus" className="size-3.5" />Prose</Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { set([...items, { quint: true, text: "" }]); focusLater(`[data-uid="${id}"] textarea[aria-label="Quint"]:last-of-type`); }}><Icon name="plus" className="size-3.5" />Quint</Button>
        <MoveMenu id={id} kind="rule" />
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => removeNode(id)}>Remove</Button>
        <span className="ml-auto font-mono">Esc finish · ⌘Z undo</span>
      </div>
    </div>
  );
}

/** On-demand right Component Peek Drawer showing live story states, wired guards, and linked rules. */
function ComponentPeek({ component, spec, graph }: { component: Component; spec: Working; graph: SpecModelGraph | undefined }) {
  const wiredRules = graph ? Object.values(graph.rules).filter((rm) => rm.components.some((c) => c.name === component.name)) : [];
  return (
    <aside aria-label="Component peek" className="flex w-88 flex-none flex-col gap-4 overflow-auto border-l border-border bg-card p-4 max-lg:hidden">
      <div className="flex flex-col gap-1 border-b border-border pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-semibold">{component.name}</h2>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => openComponent(component.id)}>
              Open in Layout <Icon name="external" className="size-3" />
            </Button>
            <IconButton name="close" label="Close peek" onClick={() => peekComponent(undefined)} />
          </div>
        </div>
        <div className="font-mono text-xs text-muted-foreground">{component.source.file}:{component.source.line}</div>
      </div>

      {component.description && <div className="text-xs text-muted-foreground"><InlineMarkdown text={component.description} file={spec.file} /></div>}

      {component.stories.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">Stories ({component.stories.length})</div>
          <div className="flex flex-col gap-1.5">
            {component.stories.slice(0, 6).map((st) => (
              <div key={st.id} className="rounded-md border border-border bg-background p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{st.name}</span>
                  <span className="font-mono text-muted-foreground">{st.kind}</span>
                </div>
                {Object.keys(st.args).length > 0 && (
                  <div className="mt-1 truncate font-mono text-muted-foreground">
                    {Object.entries(st.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {component.uses && component.uses.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">Wired Guards & Symbols</div>
          <div className="flex flex-col gap-1">
            {component.uses.map((sym) => (
              <div key={sym} className="rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-primary">{sym}</div>
            ))}
          </div>
        </div>
      )}

      {wiredRules.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">Linked Rules</div>
          <div className="flex flex-col gap-1">
            {wiredRules.map((rm) => (
              <button key={rm.key} type="button" onClick={() => reveal(spec.file, rm.key)}
                className={cn(focusRing, "flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-accent")}>
                <RuleGlyph role={rm.role} />
                <span className="min-w-0 flex-1">{rm.heading}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto pt-2">
        <Button variant="outline" size="sm" className="w-full" onClick={() => setView("split")}>
          <Icon name="split" className="size-3.5" />Open Layout ↔ State Split View
        </Button>
      </div>
    </aside>
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
    <Alert variant="warn" className={BANNER}>
      <span className="flex-1">{fresh && there.length ? there.map((k) => k.replace(/^## /, "")).join(" · ") : `${spec.file}${fresh ? "" : " (removed)"}`}</span>
      <Button variant="outline" size="sm" onClick={() => keepMine(spec.file)}>Keep mine</Button>
      <Button variant="outline" size="sm" onClick={() => takeTheirs(spec.file)}>Take disk</Button>
    </Alert>
  );
}
/** An `Alert` above the spec, with its actions at the end. */
const BANNER = "mb-4 flex items-center gap-3";

export function Spec({ spec }: { spec: Working }) {
  const { byKey, bySpec } = failures();
  const o = spec.outline;
  const headId = ui(spec.file, "head");
  const specFails = bySpec.get(spec.file)?.filter((r) => !r.rules?.length);
  const allSpecFails = bySpec.get(spec.file)?.length ?? 0;
  const graph = graphOf(spec.file);
  const peeked = S.peekComponent ? S.components?.components.find((c) => c.name === S.peekComponent || c.id === S.peekComponent) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-auto px-8 pt-6 pb-28 max-sm:px-4">
        <div className="mx-auto max-w-220">
          {S.conflicts.includes(spec.file) && <Conflict spec={spec} />}
          {!!specFails?.length && <div className="mb-4 flex flex-col gap-2">{specFails.map((r) => <Failure key={`${r.stage} ${r.summary}`} r={r} />)}</div>}
          {spec.deleted && <Alert variant="destructive" className={BANNER}><span className="flex-1">Deleted on publish.</span><Button variant="outline" size="sm" onClick={() => deleteSpec(spec, false)}>Keep</Button></Alert>}

          <div data-uid={headId} className="mb-5">
            {S.editing.has(headId) ? (
              <div data-edit className="flex flex-col gap-2 rounded-lg border border-primary/40 border-l-4 border-l-primary bg-card p-3">
                <div className="flex items-center gap-2">
                  <Input data-heading value={o.title} aria-label="Title" placeholder="Title" invalid={!o.title.trim()}
                    className="h-9 flex-1 border-transparent bg-transparent px-1.5 text-2xl font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
                    onChange={(e) => retitle(spec, e.target.value, o.body)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest("[data-edit]")?.querySelector("textarea")?.focus(); } }} />
                  <Button variant="outline" size="sm" onClick={() => doneEditing(headId)}><Icon name="check" />Done</Button>
                </div>
                <TextBox value={o.body.trim()} label="What the application is for" onChange={(v) => retitle(spec, o.title, v)} />
              </div>
            ) : (
              <>
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <h1 onDoubleClick={() => editNode(headId)} className="group flex items-center gap-2 text-2xl font-semibold">
                    {o.title || specLabel(spec.file)}
                    <span className="opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
                      <IconButton name="edit" label="Edit title and introduction" onClick={() => editNode(headId)} />
                    </span>
                  </h1>
                  <span className="font-mono text-xs text-muted-foreground">{spec.file}</span>
                </div>
                {o.body.trim() && <Markdown text={o.body} file={spec.file} className="text-sm text-muted-foreground" />}
              </>
            )}
          </div>

          <ModelSummaryStrip spec={spec} graph={graph} failingCount={allSpecFails} />

          {o.stories.map((s, i) => <StoryCard key={s.id} spec={spec} story={s} s={i} byKey={byKey} graph={graph} />)}
          <Button variant="ghost" size="sm" className="mt-2 border border-dashed border-border text-muted-foreground" onClick={() => addStory(spec)}><Icon name="plus" />Story</Button>
        </div>
      </div>

      {peeked && <ComponentPeek component={peeked} spec={spec} graph={graph} />}
    </div>
  );
}
