// The 224px left navigation rail: specs with an inline Outline TOC, hierarchical Layouts and Primitives, and ⌘K jump.
import { useState, type ReactNode } from "react";
import { Input, Skeleton, cn, focusRing } from "@repo/ui";
import type { Component, ComponentIndex } from "../../../stories/emit.ts";
import {
  S, deleteSpec, failures, find, focusLater, graphOf, isDirty, move, newSpec, openComponent, openStateFocus, redraw,
  reviewCount, select, setCmdOpen, specLabel, ui, type Working,
} from "./studio.ts";
import { Dot, Icon, IconButton, type Mark } from "./text.tsx";
import { dragging } from "./Spec.tsx";

interface LayoutRow { component: Component; depth: number }

/** Partition components into a hierarchical Layouts tree (model-bound or composing >= 2 catalogued children) and Primitives. */
function splitComponents(index: ComponentIndex) {
  const byName = new Map<string, Component>();
  for (const c of index.components) if (!byName.has(c.name)) byName.set(c.name, c);
  const isLayout = (c: Component) => !c.part && (Boolean(c.model) || (c.children?.filter((ch) => byName.has(ch)).length ?? 0) >= 2);
  const layoutCandidates = index.components.filter(isLayout);
  const childNames = new Set<string>();
  for (const c of layoutCandidates) for (const ch of c.children ?? []) {
    const child = byName.get(ch);
    if (child && isLayout(child)) childNames.add(ch);
  }

  const layoutRoots = layoutCandidates.filter((c) => !childNames.has(c.name));
  const placed = new Set<string>();
  const layouts: LayoutRow[] = [];
  const visit = (comp: Component, depth: number) => {
    if (placed.has(comp.id) || depth > 3) return;
    placed.add(comp.id);
    layouts.push({ component: comp, depth });
    for (const chName of comp.children ?? []) {
      const child = byName.get(chName);
      if (child && isLayout(child)) visit(child, depth + 1);
    }
  };
  for (const root of layoutRoots) visit(root, 0);
  // Any layout components participating in a cycle still appear as top-level layouts.
  for (const c of layoutCandidates) if (!placed.has(c.id)) visit(c, 0);

  const partCounts = new Map<string, number>();
  for (const c of index.components) if (c.part) partCounts.set(c.part, (partCounts.get(c.part) ?? 0) + 1);
  const primitives = index.components
    .filter((c) => !c.part && !placed.has(c.id))
    .map((c) => ({ component: c, parts: partCounts.get(c.name) ?? 0 }));
  return { layouts, primitives };
}

function StoryToc({ spec }: { spec: Working }) {
  if (!spec.outline.stories.length) return null;
  const jump = (storyId: number) => {
    const id = ui(spec.file, storyId);
    S.open.add(id);
    redraw();
    setTimeout(() => document.querySelector(`[data-uid="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  };
  return (
    <div className="mt-1 ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
      {spec.outline.stories.map((story) => {
        const id = ui(spec.file, story.id);
        const open = S.open.has(id);
        const label = story.title.replace(/^Story:\s*/, "").trim() || "Untitled";
        return (
          <button key={story.id} type="button" onClick={() => jump(story.id)}
            className={cn(focusRing, "flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors duration-fast hover:bg-accent",
              open ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <span className="truncate">{label}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{story.rules.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function StateToc({ spec }: { spec: Working }) {
  const graph = graphOf(spec.file);
  if (!graph || !graph.nodes.length) return null;
  const seen = new Set<string>();
  const transitions = graph.edges.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">States ({graph.nodes.length})</div>
        {graph.nodes.map((n) => (
          <button key={n.id} type="button" onClick={() => openStateFocus(spec.file, { node: n.id })}
            className={cn(focusRing, "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent", S.focusNode === n.id && "bg-accent font-medium text-foreground")}>
            <Dot mark={n.initial ? "dirty" : n.goal ? "ok" : ""} label={n.initial ? "initial" : n.goal ? "goal" : "state"} />
            <span className="flex-1 truncate">{n.label}</span>
            <span className="text-xs text-muted-foreground">{n.initial ? "init" : n.goal ? "goal" : ""}</span>
          </button>
        ))}
      </div>
      {transitions.length > 0 && (
        <div>
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Transitions ({transitions.length})</div>
          {transitions.map((e) => (
            <button key={e.id} type="button" onClick={() => openStateFocus(spec.file, { edge: e.name })}
              className={cn(focusRing, "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent", S.focusEdge === e.name && "bg-accent font-medium text-foreground")}>
              <span className="truncate font-mono">{e.name}</span>
              <span className="truncate text-xs text-muted-foreground">{e.from === e.to ? `${e.from} ↺` : `${e.from} → ${e.to}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentTree({ index }: { index: ComponentIndex }) {
  const { layouts, primitives } = splitComponents(index);
  const inComponents = S.view === "components" || S.view === "split";
  const renderSection = (title: string, children: ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <button type="button" aria-current={S.view === "components"} onClick={() => openComponent()}
        className={cn(focusRing, "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-accent", S.view === "components" && "bg-accent text-foreground")}>
        <span>Components</span>
        <span className="font-normal text-muted-foreground tabular-nums">{index.components.length}</span>
      </button>

      {layouts.length > 0 && renderSection("Layouts", layouts.map(({ component: c, depth }) => {
        const active = inComponents && (S.selectedComponentId === c.id || S.selectedComponentId === c.name);
        const meta = c.model ? specLabel(c.model.spec).split("/").pop() : "";
        return (
          <button key={c.id} type="button" aria-label={`${c.name} (${c.package})`} aria-current={active || undefined}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => openComponent(c.id)}
            className={cn(focusRing, "flex items-center justify-between gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-accent",
              active ? "bg-accent font-medium text-primary" : "text-foreground")}>
            <span className="truncate">{c.name}</span>
            {meta && <span className="font-mono text-xs text-muted-foreground">{meta}</span>}
          </button>
        );
      }))}

      {primitives.length > 0 && renderSection("Primitives", primitives.map(({ component: c, parts }) => {
        const active = inComponents && (S.selectedComponentId === c.id || S.selectedComponentId === c.name);
        const meta = parts > 0 ? `${parts} parts` : String(c.stories.length);
        return (
          <button key={c.id} type="button" aria-label={`${c.name} (${meta})`} aria-current={active || undefined}
            onClick={() => openComponent(c.id)}
            className={cn(focusRing, "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
              active ? "bg-accent font-medium text-primary" : "text-foreground")}>
            <span className="truncate">{c.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>
          </button>
        );
      }))}
    </div>
  );
}

export function Rail() {
  const fails = failures().bySpec;
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState("");
  const create = () => {
    if (!name.trim()) return;
    newSpec(name.trim());
    setName("");
    setAdding(false);
  };
  const showNewSpec = adding || (!!S.snap && S.specs.length === 0);
  const verdict = S.snap?.session.verdict;

  return (
    <aside aria-label="Specs" className="flex w-56 flex-none flex-col overflow-hidden border-r border-border bg-card max-md:w-48 max-sm:w-full max-sm:border-r-0 max-sm:border-b">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-2.5 py-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-medium text-muted-foreground">Specs</span>
            <IconButton name="plus" label="New spec" onClick={() => { setAdding((v) => !v); focusLater("[data-newspec]"); }} />
          </div>

          {!S.snap && <div className="flex flex-col gap-2 px-2"><Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" /></div>}

          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {S.specs.map((spec) => {
              const review = reviewCount(spec.file);
              const storiesCount = spec.outline.stories.length;
              const rulesCount = spec.outline.stories.reduce((n, s) => n + s.rules.length, 0);
              const [mark, label]: [Mark, string] = isDirty(spec) ? ["dirty", "unpublished changes"]
                : fails.has(spec.file) ? ["bad", "failing checks"]
                : review ? ["review", `${review} to review`]
                : verdict === "Green" ? ["ok", "all green"] : ["", ""];
              const depth = specLabel(spec.file).split("/").length - (spec.file === "spec/index.md" ? 1 : 0);
              const active = spec.file === S.sel && (S.view === "specs" || S.view === "states" || S.view === "split");
              const accepts = () => dragging?.kind === "story" && !spec.deleted && find(dragging.uid)?.spec.file !== spec.file;
              return (
                <li key={spec.file}>
                  <div style={{ paddingLeft: 8 + 10 * depth }}
                    onDragOver={(e) => { if (accepts()) { e.preventDefault(); setOver(spec.file); } }} onDragLeave={() => setOver("")}
                    onDrop={(e) => { e.preventDefault(); setOver(""); if (dragging) move(dragging.uid, { spec: spec.file }); }}
                    className={cn("group flex items-center gap-1.5 rounded-md border border-transparent pr-1 hover:bg-accent", active && "bg-accent", over === spec.file && "border-dashed border-primary")}>
                    <button type="button" title={spec.file} aria-current={active || undefined} onClick={() => select(spec.file, S.view === "states" || S.view === "split")}
                      className={cn(focusRing, "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left")}>
                      <Dot mark={mark} label={label} />
                      <span className={cn("flex-1 truncate font-mono text-xs", spec.deleted && "text-muted-foreground line-through")}>{specLabel(spec.file).split("/").pop()}</span>
                      <span title={`${storiesCount} stories · ${rulesCount} rules`} className="text-xs text-muted-foreground tabular-nums">{storiesCount}·{rulesCount}</span>
                    </button>
                    <span className="opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
                      {spec.deleted ? <IconButton name="undo" label={`Keep ${spec.file}`} onClick={() => deleteSpec(spec, false)} />
                        : <IconButton name="trash" label={`Delete ${spec.file}`} danger onClick={() => deleteSpec(spec, true)} />}
                    </span>
                  </div>
                  {S.view === "specs" && spec.file === S.sel && !spec.deleted && <StoryToc spec={spec} />}
                  {S.view === "states" && spec.file === S.sel && !spec.deleted && <StateToc spec={spec} />}
                </li>
              );
            })}
          </ul>

          {showNewSpec && (
            <div className="mt-1 flex gap-1 px-1">
              <Input data-newspec value={name} placeholder="area/child" aria-label="Path of a new spec" className="h-8 font-mono text-xs"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") create(); else if (e.key === "Escape") { setAdding(false); setName(""); } }} />
              <IconButton name="plus" label="Add spec" onClick={create} />
            </div>
          )}
        </div>

        {S.components && <ComponentTree index={S.components} />}
      </div>

      <div className="flex-none border-t border-border p-2.5">
        <button type="button" onClick={() => setCmdOpen(true)}
          className={cn(focusRing, "flex w-full items-center justify-between rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <span className="flex items-center gap-1.5"><Icon name="search" className="size-3.5" />Jump to…</span>
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">⌘K</span>
        </button>
      </div>
    </aside>
  );
}
