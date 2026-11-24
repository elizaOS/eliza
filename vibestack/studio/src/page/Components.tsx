// The Components & Layout Viewer: zero-config embedded preview (with Storybook and structured fallback),
// adaptive Layout Stage + Element Inspector for model-bound/composite components, and a consolidated
// headered Props & Controls table for isolated primitives.
import { useEffect, useMemo, useRef, useState } from "react";
import { Effect, ManagedRuntime } from "effect";
import { Button, Checkbox, EmptyState, Input, cn, focusRing } from "@repo/ui";
import { Machine, machine } from "../../gen/components.effect.vibe";
import { useMachine } from "../../gen/components.react.ts";
import { initial, type Event } from "../../gen/components.ts";
import type { RuleMeta, RuleRole, SimResult, SpecModelGraph } from "../graph.ts";
import type { Component, ComponentIndex, Prop, Story } from "../../../stories/emit.ts";
import {
  S, fetchPreview, graphOf, isDarkTheme, openComponent, openStateFocus, postSim, reveal, select, useStudio,
} from "./studio.ts";
import { Dot, Icon, InlineMarkdown } from "./text.tsx";

type Arg = string | number | boolean;
interface PreviewInfo { url: string | null; mode: "embedded" | "storybook" | "none" }
export interface Hierarchy {
  byId: Map<string, Component>;
  byName: Map<string, Component>;
  parentOf: Map<string, Component>;
  partsOf: Map<string, Component[]>;
}

const STORYBOOK = "http://localhost:6006";

const ROLE_GLYPH: Record<RuleRole, string> = {
  domain: "◇",
  transition: "→",
  always: "∀",
  step: "⊢",
  sometimes: "⚑",
  leadsTo: "↝",
  law: "≡",
  refines: "≡",
  helper: "◇",
};

function argsParam(args: Record<string, Arg>): string {
  const safe = (s: string) => /^[\w .-]*$/.test(s);
  return Object.entries(args)
    .filter(([, v]) => typeof v !== "string" || safe(v))
    .map(([k, v]) => `${k}:${typeof v === "boolean" ? `!${v}` : encodeURIComponent(String(v))}`)
    .join(";");
}

function previewUrl(storybook: string, story: string, args: Record<string, Arg> = {}): string {
  const extra = argsParam(args);
  return `${storybook.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(story)}&viewMode=story${extra ? `&args=${extra}` : ""}`;
}

const typeOf = (p: Prop) => (p.options ? p.options.map((o) => JSON.stringify(o)).join(" | ") : p.kind);
const isArg = (v: unknown): v is Arg => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function isLayoutContainer(component: Component, byName: Map<string, Component>): boolean {
  if (component.model) return true;
  const cataloguedChildren = (component.children ?? []).filter((ch) => byName.has(ch));
  return cataloguedChildren.length >= 2;
}

export function buildHierarchy(index: ComponentIndex): Hierarchy {
  const byId = new Map<string, Component>();
  const byName = new Map<string, Component>();
  const parentOf = new Map<string, Component>();
  const partsOf = new Map<string, Component[]>();
  for (const c of index.components) {
    byId.set(c.id, c);
    if (!byName.has(c.name)) byName.set(c.name, c);
    if (c.part) {
      const list = partsOf.get(c.part) ?? [];
      list.push(c);
      partsOf.set(c.part, list);
    }
  }
  for (const c of index.components) {
    if (!isLayoutContainer(c, byName)) continue;
    for (const ch of c.children ?? []) {
      if (byName.has(ch) && !parentOf.has(ch)) parentOf.set(ch, c);
    }
  }
  return { byId, byName, parentOf, partsOf };
}

function breadcrumbOf(component: Component, hierarchy: Hierarchy): Component[] {
  const chain: Component[] = [component];
  const seen = new Set([component.name]);
  let cur = hierarchy.parentOf.get(component.name);
  while (cur && !seen.has(cur.name)) {
    chain.unshift(cur);
    seen.add(cur.name);
    cur = hierarchy.parentOf.get(cur.name);
  }
  return chain;
}

export function descendantsOf(root: Component, hierarchy: Hierarchy): Component[] {
  const out: Component[] = [];
  const seen = new Set([root.name]);
  const walk = (c: Component) => {
    for (const name of c.children ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      const child = hierarchy.byName.get(name);
      if (child) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

export function isLayoutComponent(component: Component, hierarchy: Hierarchy): boolean {
  return isLayoutContainer(component, hierarchy.byName) || hierarchy.parentOf.has(component.name);
}

function modelPropName(component: Component): string | undefined {
  if (!component.model) return undefined;
  const mod = component.model.module.toLowerCase();
  const st = component.model.state.toLowerCase();
  const exact = component.props.find((p) => p.name.toLowerCase() === mod || p.name.toLowerCase() === st);
  if (exact) return exact.name;
  const modelStory = component.stories.find((s) => s.kind === "model");
  if (modelStory) {
    const key = Object.keys(modelStory.args).find((k) => component.props.some((p) => p.name === k && p.kind === "object"));
    if (key) return key;
  }
  return component.props.find((p) => p.kind === "object")?.name;
}

export function buildStageArgs(
  target: Component,
  story: Story | undefined,
  simState: unknown,
  edits: Record<string, Arg> = {},
): Record<string, unknown> {
  const modelStory = target.stories.find((s) => s.kind === "model");
  const mProp = modelPropName(target);
  const fallbackModel = mProp ? modelStory?.args[mProp] : undefined;
  const base: Record<string, unknown> = {
    ...(modelStory?.args ?? {}),
    ...(story?.args ?? {}),
  };
  if (mProp && simState !== undefined) base[mProp] = simState;
  else if (mProp && base[mProp] === undefined && fallbackModel !== undefined) base[mProp] = fallbackModel;
  return { ...base, ...edits };
}

export function usePreviewHost(): PreviewInfo {
  const [info, setInfo] = useState<PreviewInfo>({ url: null, mode: "none" });
  useEffect(() => {
    let active = true;
    fetchPreview().then(
      (res) => { if (active) setInfo(res); },
      () => { if (active) setInfo({ url: null, mode: "none" }); },
    );
    return () => { active = false; };
  }, []);
  return info;
}

export function useModelSim(moduleName: string | undefined) {
  const [result, setResult] = useState<{ module: string; sim: SimResult } | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!moduleName) return;
    let active = true;
    postSim({ module: moduleName }).then(
      (sim) => { if (active) setResult({ module: moduleName, sim }); },
      () => { if (active) setResult({ module: moduleName, sim: { available: false, module: moduleName } }); },
    );
    return () => { active = false; };
  }, [moduleName]);

  const sim = moduleName && result?.module === moduleName ? result.sim : undefined;

  const step = async (event: unknown, by?: unknown) => {
    if (!moduleName || !sim?.available) return;
    setBusy(true);
    try {
      const next = await postSim({ module: moduleName, state: sim.state, event, by });
      setResult({ module: moduleName, sim: next });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!moduleName) return;
    setBusy(true);
    try {
      const next = await postSim({ module: moduleName });
      setResult({ module: moduleName, sim: next });
    } finally {
      setBusy(false);
    }
  };

  return { sim, busy, step, reset };
}

function formatStateValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "{…}";
}

function stateEntries(state: unknown): { key: string; value: unknown; text: string }[] {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  return Object.entries(state as Record<string, unknown>).map(([key, value]) => ({
    key,
    value,
    text: formatStateValue(value),
  }));
}

function transitionNameFromGuard(symbol: string): string {
  if (symbol.startsWith("can") && symbol.length > 3 && /^[A-Z]/.test(symbol[3])) {
    return symbol[3].toLowerCase() + symbol.slice(4);
  }
  return symbol;
}

function matchGuard(symbol: string, sim: SimResult | undefined): { kind: "guard" | "helper"; allowed?: boolean; eventName?: string } {
  const target = transitionNameFromGuard(symbol);
  const found = sim?.enabledEvents?.find((ev) => ev.name === target || ev.name === symbol);
  if (found) return { kind: "guard", allowed: found.allowed, eventName: found.name };
  if (symbol.startsWith("can") && symbol.length > 3 && /^[A-Z]/.test(symbol[3])) {
    return { kind: "guard", eventName: target };
  }
  return { kind: "helper" };
}

function linkedRulesFor(component: Component, graph: SpecModelGraph | undefined): RuleMeta[] {
  if (!graph) return [];
  const seen = new Set<string>();
  const out: RuleMeta[] = [];
  for (const rule of Object.values(graph.rules)) {
    const byComp = rule.components.some((rc) => rc.id === component.id || rc.name === component.name);
    const byCit = component.citations?.some((cit) => cit.spec === graph.file && (cit.heading === rule.heading || cit.heading === rule.story));
    const bySym = component.uses?.some((sym) => rule.defs.includes(sym));
    if ((byComp || byCit || bySym) && !seen.has(rule.key)) {
      seen.add(rule.key);
      out.push(rule);
    }
  }
  return out;
}

const FileLink = ({ path }: { path: string }) => (
  S.specs.some((s) => s.file === path)
    ? <Button variant="ghost" size="sm" className="h-auto px-1 py-0 font-mono text-xs text-primary" onClick={() => select(path)}>{path}</Button>
    : <a href={encodeURI(`vscode://file/${S.snap?.project.root.replaceAll("\\", "/").replace(/^\/+/, "")}/${path.replace(/#.*$/, "")}`)} className="font-mono text-xs text-primary hover:underline">{path}</a>
);

function StructuredFallback({
  target,
  inspected,
  hierarchy,
  story,
  args,
  onSelectComponent,
  onTryStorybook,
}: {
  target: Component;
  inspected: Component;
  hierarchy: Hierarchy;
  story: Story | undefined;
  args: Record<string, unknown>;
  onSelectComponent?: (name: string) => void;
  onTryStorybook?: () => void;
}) {
  const descendants = descendantsOf(target, hierarchy);
  const argEntries = Object.entries(args).filter(([, v]) => v !== undefined);
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-foreground">{target.name}</span>
          {story && <span className="rounded-sm bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{story.name}</span>}
        </div>
        {onTryStorybook && story && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onTryStorybook}>
            Use Storybook (:6006)
          </Button>
        )}
      </div>

      {descendants.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-background p-3">
          <div className="text-xs font-medium text-muted-foreground">Component composition</div>
          <div className="flex flex-wrap gap-2">
            {descendants.map((child) => {
              const active = inspected.name === child.name;
              return (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelectComponent?.(child.name)}
                  className={cn(
                    focusRing,
                    "rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors duration-fast",
                    active ? "border-primary bg-accent font-medium text-primary" : "border-border bg-card text-foreground hover:bg-accent",
                  )}
                >
                  <div className="font-mono">{child.name}</div>
                  {child.uses?.length ? (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">{child.uses.join(", ")}</div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {argEntries.length > 0 ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md bg-muted/60 p-3 font-mono text-xs">
          {argEntries.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-muted-foreground">{k}</span>
              <span className="truncate text-foreground">{isArg(v) ? String(v) : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Structured preview — interactive controls and metadata are active below.</p>
      )}
    </div>
  );
}

export function CompositionStrip({
  root,
  inspected,
  hierarchy,
  onSelectComponent,
}: {
  root: Component;
  inspected: Component;
  hierarchy: Hierarchy;
  onSelectComponent: (name: string) => void;
}) {
  const descendants = descendantsOf(root, hierarchy);
  if (!descendants.length) return null;
  return (
    <div role="group" aria-label="Layout elements" className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">Elements</span>
      <button
        type="button"
        aria-label={`Inspect ${root.name}`}
        aria-pressed={inspected.name === root.name}
        onClick={() => onSelectComponent(root.name)}
        className={cn(
          focusRing,
          "rounded-sm px-2 py-0.5 font-mono transition-colors duration-fast",
          inspected.name === root.name ? "bg-accent font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {root.name}
      </button>
      {descendants.map((child) => (
        <button
          key={child.id}
          type="button"
          aria-pressed={inspected.name === child.name}
          onClick={() => onSelectComponent(child.name)}
          className={cn(
            focusRing,
            "rounded-sm px-2 py-0.5 font-mono transition-colors duration-fast",
            inspected.name === child.name ? "bg-accent font-medium text-primary" : "text-foreground hover:bg-accent",
          )}
        >
          {child.name}
        </button>
      ))}
    </div>
  );
}

export function LivePreviewStage({
  target,
  inspected,
  hierarchy,
  preview,
  story,
  args,
  scalarEdits,
  inspect,
  viewport,
  compact = false,
  onSelectComponent,
  onAction,
}: {
  target: Component;
  inspected: Component;
  hierarchy: Hierarchy;
  preview: PreviewInfo;
  story: Story | undefined;
  args: Record<string, unknown>;
  scalarEdits?: Record<string, Arg>;
  inspect: boolean;
  viewport: "desktop" | "mobile";
  compact?: boolean;
  onSelectComponent?: (name: string) => void;
  onAction?: (prop: string, actionArgs: unknown[]) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const [useStorybook, setUseStorybook] = useState(false);
  const theme = isDarkTheme() ? "dark" : "light";
  const allChildren = useMemo(
    () => [target.name, ...descendantsOf(target, hierarchy).map((c) => c.name)],
    [target, hierarchy],
  );
  const propNames = useMemo(() => target.props.map((p) => p.name), [target.props]);

  const payloadRef = useRef({
    file: target.source.file,
    name: target.name,
    args,
    props: propNames,
    children: allChildren,
    inspect,
    theme,
  });

  useEffect(() => {
    payloadRef.current = {
      file: target.source.file,
      name: target.name,
      args,
      props: propNames,
      children: allChildren,
      inspect,
      theme,
    };
    if (readyRef.current) {
      iframeRef.current?.contentWindow?.postMessage({ type: "studio:preview", ...payloadRef.current }, "*");
    }
  }, [target.source.file, target.name, args, propNames, allChildren, inspect, theme]);

  useEffect(() => {
    if (preview.mode !== "embedded" || !preview.url) return;
    const onMsg = (ev: MessageEvent) => {
      if (iframeRef.current?.contentWindow && ev.source !== iframeRef.current.contentWindow) return;
      const data = ev.data as { type?: string; componentName?: string; prop?: string; args?: unknown[] } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "studio:ready") {
        readyRef.current = true;
        iframeRef.current?.contentWindow?.postMessage({ type: "studio:preview", ...payloadRef.current }, "*");
      } else if (data.type === "studio:select" && typeof data.componentName === "string") {
        onSelectComponent?.(data.componentName);
      } else if (data.type === "studio:action" && typeof data.prop === "string") {
        onAction?.(data.prop, Array.isArray(data.args) ? data.args : []);
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      readyRef.current = false;
      window.removeEventListener("message", onMsg);
    };
  }, [preview.mode, preview.url, onSelectComponent, onAction]);

  const frameClass = cn(
    "w-full rounded-lg border border-border bg-card transition-all duration-fast",
    compact ? "h-80" : "h-96",
    viewport === "mobile" && "mx-auto max-w-sm",
  );

  if (preview.mode === "embedded" && preview.url) {
    return (
      <div className={cn("w-full", viewport === "mobile" && "mx-auto max-w-sm")}>
        <iframe
          ref={iframeRef}
          title={`${target.name}: ${story?.name ?? "Preview"}`}
          src={preview.url}
          className={frameClass}
        />
      </div>
    );
  }

  if ((preview.mode === "storybook" && preview.url && story) || (useStorybook && story)) {
    const base = preview.mode === "storybook" && preview.url ? preview.url : STORYBOOK;
    return (
      <div className={cn("w-full", viewport === "mobile" && "mx-auto max-w-sm")}>
        <iframe
          title={`${target.name}: ${story.name}`}
          src={previewUrl(base, story.id, scalarEdits ?? {})}
          className={frameClass}
        />
      </div>
    );
  }

  return (
    <div className={cn("w-full", viewport === "mobile" && "mx-auto max-w-sm")}>
      <StructuredFallback
        target={target}
        inspected={inspected}
        hierarchy={hierarchy}
        story={story}
        args={args}
        onSelectComponent={onSelectComponent}
        onTryStorybook={() => setUseStorybook(true)}
      />
    </div>
  );
}

export function SimStateBar({
  label,
  sim,
  busy,
  highlightSymbols,
  lastAction,
  onStep,
  onReset,
}: {
  label: string;
  sim: SimResult | undefined;
  busy: boolean;
  highlightSymbols?: string[];
  lastAction?: string;
  onStep: (event: unknown, by?: unknown) => void;
  onReset: () => void;
}) {
  const entries = stateEntries(sim?.state).slice(0, 5);
  const allowedEvents = (sim?.enabledEvents ?? []).filter((e) => e.allowed);
  const highlighted = new Set((highlightSymbols ?? []).map(transitionNameFromGuard));
  const sortedEvents = [...allowedEvents].sort((a, b) => Number(highlighted.has(b.name)) - Number(highlighted.has(a.name)));

  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-4 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono">
        <Dot mark={sim?.available ? (sim.inv === false ? "bad" : "ok") : ""} label={sim?.available ? (sim.inv === false ? "invariant violated" : "live simulation") : "simulation unavailable"} />
        <span className="font-semibold text-foreground">{label}</span>
        {sim?.available ? (
          <>
            {entries.map((entry) => (
              <span key={entry.key} className="text-muted-foreground">
                {entry.key}=
                <strong className={cn("font-medium", typeof entry.value === "boolean" ? (entry.value ? "text-ok" : "text-warn") : "text-foreground")}>
                  {entry.text}
                </strong>
              </span>
            ))}
            {sim.inv !== undefined && (
              <span className={sim.inv ? "text-ok" : "text-destructive"}>{sim.inv ? "inv ✓" : "inv ✗"}</span>
            )}
          </>
        ) : (
          <span className="font-sans text-muted-foreground">Simulation available after check</span>
        )}
        {lastAction && <span className="text-primary">· {lastAction}</span>}
      </div>
      {sim?.available && (
        <div className="flex flex-wrap items-center gap-1.5">
          {sortedEvents.slice(0, 4).map((ev) => (
            <Button
              key={ev.name}
              variant={highlighted.has(ev.name) ? "primary" : "outline"}
              size="sm"
              disabled={busy}
              className="h-7 px-2 font-mono text-xs"
              onClick={() => onStep(ev.sampleEvent, ev.sender)}
            >
              ▶ {ev.name}
            </Button>
          ))}
          <Button variant="ghost" size="sm" disabled={busy} className="h-7 px-2 text-xs" onClick={onReset}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}

function hasInteractiveControl(prop: Prop): boolean {
  return prop.kind === "boolean" || prop.kind === "number" || prop.kind === "string" || Boolean(prop.options?.every(isArg));
}

function PropControl({
  prop,
  story,
  current,
  onChange,
  compact = false,
}: {
  prop: Prop;
  story: Story | undefined;
  current: unknown;
  onChange: (value: Arg) => void;
  compact?: boolean;
}) {
  if (prop.kind === "boolean") {
    return (
      <label className="inline-flex items-center gap-2 text-xs text-foreground">
        <Checkbox checked={current === true} aria-label={prop.name} onCheckedChange={(on) => onChange(on === true)} />
        <span className="font-mono text-muted-foreground">{current === true ? "true" : "false"}</span>
      </label>
    );
  }
  if (prop.options?.every(isArg)) {
    return (
      <div role="group" aria-label={prop.name} className="flex flex-wrap items-center gap-1">
        {prop.options.map((o) => (
          <Button
            key={String(o)}
            variant={o === current ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={o === current}
            className="h-7 px-2 font-mono text-xs"
            onClick={() => onChange(o)}
          >
            {String(o)}
          </Button>
        ))}
      </div>
    );
  }
  if (prop.kind === "number" || prop.kind === "string") {
    return (
      <Input
        key={`${story?.id} ${prop.name}`}
        className={cn("h-8 font-mono text-xs", compact ? "w-full" : "w-44")}
        type={prop.kind === "number" ? "number" : "text"}
        aria-label={prop.name}
        defaultValue={isArg(current) ? String(current) : ""}
        onChange={(e) => onChange(prop.kind === "number" ? Number(e.target.value) : e.target.value)}
      />
    );
  }
  return <span className="font-mono text-xs text-muted-foreground">—</span>;
}

function PropsTable({
  component,
  story,
  edits,
  onEdit,
  compact = false,
}: {
  component: Component;
  story: Story | undefined;
  edits: Record<string, Arg>;
  onEdit: (name: string, value: Arg) => void;
  compact?: boolean;
}) {
  if (!component.props.length) return <p className="text-xs text-muted-foreground">No props declared.</p>;
  if (compact) {
    return (
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-xs">
        {component.props.map((p) => {
          const current = edits[p.name] ?? story?.args[p.name] ?? p.default;
          return (
            <div key={p.name} className="flex flex-col gap-1.5 px-2.5 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="font-mono font-medium text-foreground whitespace-nowrap">{p.name + (p.required ? "" : "?")}</code>
                <code className="font-mono text-muted-foreground break-all">{typeOf(p)}</code>
              </div>
              {hasInteractiveControl(p) && (
                <PropControl prop={p} story={story} current={current} onChange={(v) => onEdit(p.name, v)} compact />
              )}
              {p.description && (
                <p className="text-muted-foreground">
                  <InlineMarkdown text={p.description} />
                </p>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table aria-label="Props and live controls" className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-muted-foreground">
            <th className="px-3 py-2 font-medium whitespace-nowrap">Prop</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Control</th>
            <th className="px-3 py-2 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {component.props.map((p) => {
            const current = edits[p.name] ?? story?.args[p.name] ?? p.default;
            return (
              <tr key={p.name} className="border-b border-border align-middle last:border-b-0">
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <code className="font-mono font-medium text-foreground whitespace-nowrap">{p.name + (p.required ? "" : "?")}</code>
                </td>
                <td className="px-3 py-2 align-top">
                  <code className="font-mono text-muted-foreground">{typeOf(p)}</code>
                  {p.default !== undefined && (
                    <span className="ml-2 rounded-sm bg-muted px-1 py-0.5 font-mono text-muted-foreground">= {JSON.stringify(p.default)}</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <PropControl prop={p} story={story} current={current} onChange={(v) => onEdit(p.name, v)} />
                </td>
                <td className="px-3 py-2 align-top text-muted-foreground">
                  {p.description ? <InlineMarkdown text={p.description} /> : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ElementInspector({
  component,
  story,
  hierarchy,
  graph,
  sim,
  edits,
  onEdit,
  onSelectComponent,
}: {
  component: Component;
  story: Story | undefined;
  hierarchy: Hierarchy;
  graph: SpecModelGraph | undefined;
  sim: SimResult | undefined;
  edits: Record<string, Arg>;
  onEdit: (name: string, value: Arg) => void;
  onSelectComponent: (name: string) => void;
}) {
  const crumb = breadcrumbOf(component, hierarchy);
  const rules = linkedRulesFor(component, graph);
  const fields = stateEntries(sim?.state);
  const uses = component.uses ?? [];
  const fileLinks = [
    ...(component.model ? [component.model.spec] : []),
    ...(component.design ?? []),
    `${component.source.file}:${component.source.line}`,
  ];

  return (
    <aside aria-label="Element inspector" className="flex min-h-0 flex-col gap-4 overflow-auto border-l border-border bg-card p-4 max-xl:border-t max-xl:border-l-0">
      <div className="flex flex-col gap-1.5 border-b border-border pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-semibold text-foreground">{component.name}</h2>
          {component.model && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => select(component.model!.spec)}>
                Spec ↗
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openStateFocus(component.model!.spec)}>
                States
              </Button>
            </div>
          )}
        </div>
        {crumb.length > 1 && (
          <nav aria-label="Element breadcrumb" className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
            {crumb.map((c, idx) => (
              <span key={c.id} className="inline-flex items-center gap-1">
                {idx > 0 && <span>›</span>}
                {idx < crumb.length - 1 ? (
                  <button type="button" className={cn(focusRing, "rounded-sm hover:text-foreground")} onClick={() => onSelectComponent(c.name)}>
                    {c.name}
                  </button>
                ) : (
                  <span className="font-medium text-foreground">{c.name}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {fileLinks.map((path) => <FileLink key={path} path={path} />)}
        </div>
      </div>

      {component.description && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <InlineMarkdown text={component.description} />
        </p>
      )}
      {component.diagnostics.map((d) => <p key={d} role="alert" className="text-xs text-destructive">{d}</p>)}

      {component.model && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Model State & Live Guards</span>
            <span className="font-mono">{component.model.state}</span>
          </div>
          <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-xs">
            {fields.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-2 px-2.5 py-1.5 font-mono">
                <span className="text-muted-foreground">{component.model!.module}.{f.key}</span>
                <span className={cn(typeof f.value === "boolean" ? (f.value ? "text-ok" : "text-warn") : "text-foreground")}>{f.text}</span>
              </div>
            ))}
            {uses.map((sym) => {
              const info = matchGuard(sym, sim);
              return (
                <div key={sym} className="flex items-center justify-between gap-2 px-2.5 py-1.5 font-mono">
                  <span className="truncate text-primary">{sym}</span>
                  {info.kind === "guard" ? (
                    info.allowed === undefined ? (
                      <span className="text-muted-foreground">guard</span>
                    ) : (
                      <span className={info.allowed ? "text-ok" : "text-warn"}>{info.allowed ? "✓ allowed" : "✗ blocked"}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">derived</span>
                  )}
                </div>
              );
            })}
            {!fields.length && !uses.length && (
              <div className="px-2.5 py-2 font-mono text-muted-foreground">{component.model.events.join(" · ")}</div>
            )}
          </div>
        </section>
      )}

      {(rules.length > 0 || (component.citations?.length ?? 0) > 0) && (
        <section className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">Linked Stories & Rules</div>
          <div className="flex flex-col gap-1">
            {rules.length > 0 ? rules.map((rule) => (
              <button
                key={rule.key}
                type="button"
                onClick={() => reveal(graph!.file, rule.key)}
                className={cn(focusRing, "flex items-baseline gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-accent")}
              >
                <span className="font-mono text-primary">{ROLE_GLYPH[rule.role]}</span>
                <span className="min-w-0 flex-1 text-foreground">{rule.heading}</span>
              </button>
            )) : component.citations?.map((cit) => (
              <button
                key={`${cit.spec}:${cit.heading}`}
                type="button"
                onClick={() => select(cit.spec)}
                className={cn(focusRing, "flex items-baseline gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-accent")}
              >
                <span className="font-mono text-primary">↗</span>
                <span className="min-w-0 flex-1 text-foreground">{cit.heading}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="text-xs font-medium text-muted-foreground">Props</div>
        <PropsTable component={component} story={story} edits={edits} onEdit={onEdit} compact />
      </section>
    </aside>
  );
}

interface ViewerProps {
  component: Component;
  story: Story | undefined;
  hierarchy: Hierarchy;
  preview: PreviewInfo;
  canChooseStory: (at: number) => boolean;
  edits: Record<string, Arg>;
  onChooseStory: (at: number) => void;
  onEdit: (name: string, value: Arg) => void;
  onSelectComponent: (name: string) => void;
}

export function dispatchPreviewAction(
  prop: string,
  actionArgs: unknown[],
  sim: SimResult | undefined,
  step: (event: unknown, by?: unknown) => Promise<void>,
): string {
  const summary = `${prop}(${actionArgs.map((a) => JSON.stringify(a)).join(", ")})`;
  if (prop === "onOnline" && typeof actionArgs[0] === "boolean" && sim?.available) {
    const targetName = actionArgs[0] ? "goOnline" : "goOffline";
    const ev = sim.enabledEvents?.find((e) => e.name === targetName && e.allowed);
    if (ev) void step(ev.sampleEvent, ev.sender);
  }
  return summary;
}

function StoryButtons({
  stories,
  activeStory,
  canChoose,
  onChoose,
  className,
}: {
  stories: Story[];
  activeStory: Story | undefined;
  canChoose: (at: number) => boolean;
  onChoose: (at: number) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Stories" className={cn("flex flex-wrap items-center gap-1", className)}>
      {stories.map((s, at) => (
        <button
          key={s.id}
          type="button"
          aria-pressed={s === activeStory}
          disabled={!canChoose(at)}
          onClick={() => onChoose(at)}
          className={cn(
            focusRing,
            "rounded-md px-2.5 py-1 text-xs transition-colors duration-fast hover:bg-accent",
            s === activeStory ? "bg-accent font-medium text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}

function ViewportToggle({
  viewport,
  onChange,
}: {
  viewport: "desktop" | "mobile";
  onChange: (vp: "desktop" | "mobile") => void;
}) {
  return (
    <div role="group" aria-label="Viewport" className="flex items-center rounded-md border border-border bg-background p-0.5">
      {(["desktop", "mobile"] as const).map((vp) => (
        <button
          key={vp}
          type="button"
          aria-pressed={viewport === vp}
          onClick={() => onChange(vp)}
          className={cn(
            focusRing,
            "rounded-sm px-2 py-0.5 text-xs capitalize transition-colors duration-fast",
            viewport === vp ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {vp}
        </button>
      ))}
    </div>
  );
}

function LayoutViewer({
  component,
  story,
  hierarchy,
  preview,
  canChooseStory,
  edits,
  onChooseStory,
  onEdit,
  onSelectComponent,
}: ViewerProps) {
  const [inspect, setInspect] = useState(true);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [isolate, setIsolate] = useState(false);
  const [lastAction, setLastAction] = useState<string>();

  const crumb = breadcrumbOf(component, hierarchy);
  const root = crumb[0];
  const stageTarget = isolate ? component : root;
  const model = component.model ?? stageTarget.model;
  const graph = model ? graphOf(model.spec) : undefined;
  const { sim, busy, step, reset } = useModelSim(model?.module);
  const stageStory = stageTarget === component ? story : (stageTarget.stories.find((s) => s.name === story?.name) ?? stageTarget.stories[0]);
  const stageArgs = useMemo(
    () => buildStageArgs(stageTarget, stageStory, sim?.state, stageTarget === component ? edits : {}),
    [stageTarget, stageStory, sim?.state, component, edits],
  );

  const handleAction = (prop: string, actionArgs: unknown[]) => {
    setLastAction(dispatchPreviewAction(prop, actionArgs, sim, step));
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_348px] max-xl:grid-cols-1">
      <div className="flex min-h-0 flex-col bg-background">
        <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <StoryButtons stories={component.stories} activeStory={story} canChoose={canChooseStory} onChoose={onChooseStory} />

          <div className="flex flex-wrap items-center gap-2">
            {root !== component && (
              <Button variant="ghost" size="sm" className="h-7 px-2 font-mono text-xs" onClick={() => setIsolate((v) => !v)}>
                {isolate ? `Show in ${root.name}` : `Isolate ${component.name}`}
              </Button>
            )}
            <Button
              variant={inspect ? "primary" : "outline"}
              size="sm"
              aria-pressed={inspect}
              className="h-7 px-2.5 text-xs"
              onClick={() => setInspect((v) => !v)}
            >
              Inspect {inspect ? "ON" : "OFF"}
            </Button>
            <ViewportToggle viewport={viewport} onChange={setViewport} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5">
          <CompositionStrip root={root} inspected={component} hierarchy={hierarchy} onSelectComponent={onSelectComponent} />
          <LivePreviewStage
            target={stageTarget}
            inspected={component}
            hierarchy={hierarchy}
            preview={preview}
            story={stageStory}
            args={stageArgs}
            scalarEdits={edits}
            inspect={inspect}
            viewport={viewport}
            onSelectComponent={onSelectComponent}
            onAction={handleAction}
          />
        </div>

        {model && (
          <SimStateBar
            label={model.state}
            sim={sim}
            busy={busy}
            highlightSymbols={component.uses}
            lastAction={lastAction}
            onStep={(event, by) => void step(event, by)}
            onReset={() => void reset()}
          />
        )}
      </div>

      <ElementInspector
        component={component}
        story={story}
        hierarchy={hierarchy}
        graph={graph}
        sim={sim}
        edits={edits}
        onEdit={onEdit}
        onSelectComponent={onSelectComponent}
      />
    </div>
  );
}

function PrimitiveViewer({
  component,
  story,
  hierarchy,
  preview,
  canChooseStory,
  edits,
  onChooseStory,
  onEdit,
  onSelectComponent,
}: ViewerProps) {
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const stageArgs = useMemo(() => buildStageArgs(component, story, undefined, edits), [component, story, edits]);
  const parts = hierarchy.partsOf.get(component.name) ?? [];
  const fileLinks = [...(component.design ?? []), `${component.source.file}:${component.source.line}`];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-5 max-sm:px-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xl font-semibold text-foreground">{component.name}</h2>
              <span className="font-mono text-xs text-muted-foreground">{component.package}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {fileLinks.map((path) => <FileLink key={path} path={path} />)}
            </div>
          </div>
          {component.description && (
            <p className="text-sm text-muted-foreground">
              <InlineMarkdown text={component.description} />
            </p>
          )}
          {parts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              <span className="text-muted-foreground">Parts:</span>
              {parts.map((part) => (
                <button
                  key={part.id}
                  type="button"
                  onClick={() => onSelectComponent(part.name)}
                  className={cn(focusRing, "rounded-sm border border-border bg-card px-2 py-0.5 font-mono text-foreground hover:bg-accent")}
                >
                  {part.name}
                </button>
              ))}
            </div>
          )}
          {component.diagnostics.map((d) => <p key={d} role="alert" className="text-xs text-destructive">{d}</p>)}
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
            <span className="font-mono text-foreground">Story: {story?.name ?? "None"}</span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {preview.mode === "embedded" ? "Embedded preview" : preview.mode === "storybook" ? "Storybook" : "Structured preview"}
              </span>
              <ViewportToggle viewport={viewport} onChange={setViewport} />
            </div>
          </div>

          <div className="p-4">
            <LivePreviewStage
              target={component}
              inspected={component}
              hierarchy={hierarchy}
              preview={preview}
              story={story}
              args={stageArgs}
              scalarEdits={edits}
              inspect={false}
              viewport={viewport}
              compact
            />
          </div>

          {component.stories.length > 0 && (
            <StoryButtons
              stories={component.stories}
              activeStory={story}
              canChoose={canChooseStory}
              onChoose={onChooseStory}
              className="gap-1.5 border-t border-border bg-background/60 px-4 py-2"
            />
          )}
        </div>

        <PropsTable component={component} story={story} edits={edits} onEdit={onEdit} />
      </div>
    </div>
  );
}

/** Which component and story the view shows, for as long as the page is open. */
const catalog = ManagedRuntime.make(machine());

/** The generated catalog's selected preview. @model spec/components.md */
export function Components({ index }: { index: ComponentIndex }) {
  useStudio();
  const [query, setQuery] = useState("");
  const { state: selection = initial, can, send } = useMachine(catalog);
  const preview = usePreviewHost();
  const hierarchy = useMemo(() => buildHierarchy(index), [index]);

  const component = index.components[selection.component];
  const story = component?.stories[selection.story];

  // spec/components.md, "Choosing a component selects its first story and clears prop overrides"; spec/components.md, "Choosing a story stays within its component and clears prop overrides"
  const shown = `${selection.key} ${selection.component} ${selection.story}`;
  const [edited, setEdited] = useState<{ shown: string; args: Record<string, Arg> }>({ shown, args: {} });
  const edits = edited.shown === shown ? edited.args : {};

  const choose = (event: Event) => {
    setEdited({ shown: "", args: {} });
    if (event.type === "chooseComponent") {
      const picked = index.components[event.at];
      if (picked) openComponent(picked.id);
    }
    void send(event);
  };

  // spec/components.md, "Loading a catalog selects its first component and that component's first story"
  const key = JSON.stringify(index.components.map((c) => [c.id, c.stories.map((s) => s.id)]));
  useEffect(() => {
    const counts = (JSON.parse(key) as [string, string[]][]).map(([, stories]) => stories.length);
    void catalog.runPromiseExit(Effect.flatMap(Effect.service(Machine), (m) => m.send({ type: "load", counts, key })));
  }, [key]);

  const selectedId = S.selectedComponentId;
  useEffect(() => {
    if (!selectedId || selection.key !== key) return;
    const at = index.components.findIndex((c) => c.id === selectedId || c.name === selectedId);
    if (at >= 0 && at !== selection.component) {
      void catalog.runPromiseExit(Effect.flatMap(Effect.service(Machine), (m) => m.send({ type: "chooseComponent", at })));
    }
  }, [selectedId, index, key, selection.key, selection.component]);

  const selectByName = (name: string) => {
    const at = index.components.findIndex((c) => c.name === name || c.id === name);
    if (at >= 0 && can({ type: "chooseComponent", at })) choose({ type: "chooseComponent", at });
  };

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const topComponents = index.components.filter((c) => {
    if (words.length) {
      const text = [c.package, c.name, c.model?.spec, ...c.stories.map((s) => s.name)].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    }
    return !c.part && !hierarchy.parentOf.has(c.name);
  });

  const handleEdit = (name: string, value: Arg) => setEdited({ shown, args: { ...edits, [name]: value } });
  const viewerProps = component
    ? {
      component,
      story,
      hierarchy,
      preview,
      canChooseStory: (at: number) => can({ type: "chooseStory", at }),
      edits,
      onChooseStory: (at: number) => choose({ type: "chooseStory", at }),
      onEdit: handleEdit,
      onSelectComponent: selectByName,
    }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <nav aria-label="Component switcher" className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {topComponents.map((c) => {
            const at = index.components.indexOf(c);
            const isCurrent = c === component || component?.part === c.name || (component ? breadcrumbOf(component, hierarchy)[0] === c : false);
            return (
              <button
                key={c.id}
                type="button"
                aria-current={isCurrent || undefined}
                disabled={!can({ type: "chooseComponent", at })}
                onClick={() => choose({ type: "chooseComponent", at })}
                className={cn(
                  focusRing,
                  "rounded-md px-2.5 py-1 text-xs transition-colors duration-fast hover:bg-accent",
                  isCurrent ? "bg-accent font-medium text-primary" : "text-foreground",
                )}
              >
                {c.name}
              </button>
            );
          })}
        </div>
        {index.components.length > 6 && (
          <div className="flex items-center gap-1.5">
            <Icon name="search" className="size-3.5 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Filter components…"
              aria-label="Search components"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 w-44 text-xs"
            />
          </div>
        )}
      </nav>

      {viewerProps ? (
        isLayoutComponent(viewerProps.component, hierarchy) ? <LayoutViewer {...viewerProps} /> : <PrimitiveViewer {...viewerProps} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState title="No components yet" />
        </div>
      )}
    </div>
  );
}
