// The Components view: every React component the story generator found, its generated stories as live previews,
// and its spec model, source and design document. It reads the catalog `vibestack/stories/cli.ts gen` writes
// (../../../stories/emit.ts, `ComponentIndex`), as the server collects it from the project (../project.ts, `componentsOf`).
import { useEffect, useState } from "react";
import { Effect, ManagedRuntime } from "effect";
import { Button, Checkbox, EmptyState, Input, cn } from "@repo/ui";
import { Machine, machine } from "../../gen/components.effect.vibe";
import { useMachine } from "../../gen/components.react.ts";
import { initial, type Event } from "../../gen/components.ts";
import { S, select } from "./studio.ts";
import { Code } from "./text.tsx";
import type { Component, ComponentIndex, Prop } from "../../../stories/emit.ts";

type Arg = string | number | boolean;

/** Where Storybook serves previews: `pnpm storybook`'s port. */
const STORYBOOK = "http://localhost:6006";

/** Storybook's `args` URL parameter: `key:value;…`, with `!` marking a boolean. */
function argsParam(args: Record<string, Arg>): string {
  const safe = (s: string) => /^[\w .-]*$/.test(s);
  return Object.entries(args)
    .filter(([, v]) => typeof v !== "string" || safe(v))
    .map(([k, v]) => `${k}:${typeof v === "boolean" ? `!${v}` : encodeURIComponent(String(v))}`)
    .join(";");
}

/** The address of one story's preview. */
export function previewUrl(storybook: string, story: string, args: Record<string, Arg> = {}): string {
  const extra = argsParam(args);
  return `${storybook.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(story)}&viewMode=story${extra ? `&args=${extra}` : ""}`;
}

/** The components whose package, name, model, or a story's name contains every word of the query. */
function matching(index: ComponentIndex, query: string): Component[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.components.filter((c) => {
    const text = [c.package, c.name, c.model?.spec, ...c.stories.map((s) => s.name)].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const typeOf = (p: Prop) => (p.options ? p.options.map((o) => JSON.stringify(o)).join(" | ") : p.kind);
const isArg = (v: unknown): v is Arg => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** A file of the project, by its path from the root: one of the specs opens in the Specs view, any other in the editor. */
const File = ({ path }: { path: string }) => (S.specs.some((s) => s.file === path)
  ? <Button variant="ghost" size="sm" className="h-auto px-1 py-0 font-mono text-xs text-primary" onClick={() => select(path)}>{path}</Button>
  : <a href={encodeURI(`vscode://file/${S.snap?.project.root.replaceAll("\\", "/").replace(/^\/+/, "")}/${path.replace(/#.*$/, "")}`)} className="font-mono text-xs text-primary">{path}</a>);

/** Which component and story the view shows, for as long as the page is open. */
const catalog = ManagedRuntime.make(machine());

/** The generated catalog's selected preview. @model spec/components.md */
export function Components({ index }: { index: ComponentIndex }) {
  const [query, setQuery] = useState("");
  const { state: selection = initial, can, send } = useMachine(catalog);
  const component = index.components[selection.component];
  const story = component?.stories[selection.story];
  // spec/components.md, "Choosing a component selects its first story and clears prop overrides"; spec/components.md, "Choosing a story stays within its component and clears prop overrides"
  const shown = `${selection.key} ${selection.component} ${selection.story}`;
  const [edited, setEdited] = useState<{ shown: string; args: Record<string, Arg> }>({ shown, args: {} });
  const edits = edited.shown === shown ? edited.args : {};
  const choose = (event: Event) => { setEdited({ shown: "", args: {} }); void send(event); };
  // spec/components.md, "Loading a catalog selects its first component and that component's first story"
  const key = JSON.stringify(index.components.map((c) => [c.id, c.stories.map((s) => s.id)]));
  useEffect(() => {
    const counts = (JSON.parse(key) as [string, string[]][]).map(([, stories]) => stories.length);
    void catalog.runPromiseExit(Effect.flatMap(Effect.service(Machine), (m) => m.send({ type: "load", counts, key })));
  }, [key]);
  /** Whether Storybook answers; a fetch it cannot answer fails, one it answers is opaque. */
  const [storybook, setStorybook] = useState<boolean>();
  useEffect(() => {
    const asking = new AbortController();
    fetch(STORYBOOK, { mode: "no-cors", signal: asking.signal }).then(() => setStorybook(true), () => { if (!asking.signal.aborted) setStorybook(false); });
    return () => asking.abort();
  }, []);
  const found = matching(index, query);

  const control = (p: Prop) => {
    const current = edits[p.name] ?? story?.args[p.name] ?? p.default;
    const set = (v: Arg) => setEdited({ shown, args: { ...edits, [p.name]: v } });
    if (p.kind === "boolean") return <label key={p.name} className="flex items-center gap-2"><Checkbox checked={current === true} onCheckedChange={(on) => set(on === true)} />{p.name}</label>;
    if (p.options?.every(isArg)) return (
      <div key={p.name} role="group" aria-label={p.name} className="flex items-center gap-1">{p.name}
        {p.options.map((o) => <Button key={String(o)} variant={o === current ? "secondary" : "ghost"} size="sm" aria-pressed={o === current} onClick={() => set(o)}>{String(o)}</Button>)}
      </div>);
    // Keyed by the story, so a field starts from each story's own value.
    if (p.kind === "number" || p.kind === "string") return (
      <label key={`${story?.id} ${p.name}`} className="flex items-center gap-2">{p.name}
        <Input className="h-8 w-40" type={p.kind === "number" ? "number" : "text"} defaultValue={isArg(current) ? String(current) : ""}
          onChange={(e) => set(p.kind === "number" ? Number(e.target.value) : e.target.value)} />
      </label>);
    return null;
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_1fr] gap-6 max-sm:grid-cols-1">
      <nav aria-label="Components" className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Input type="search" placeholder="Search" aria-label="Search components" value={query} onChange={(e) => setQuery(e.target.value)} />
        {[...new Set(found.map((c) => c.package))].map((pkg) => (
          <div key={pkg} className="flex flex-col">
            <h3 className="mt-3 mb-1 text-xs font-medium text-muted-foreground">{pkg}</h3>
            {found.filter((c) => c.package === pkg).map((c) => (
              <button key={c.id} type="button" aria-current={c === component} disabled={!can({ type: "chooseComponent", at: index.components.indexOf(c) })} onClick={() => choose({ type: "chooseComponent", at: index.components.indexOf(c) })}
                className={cn("rounded-md px-2 py-1 text-left hover:bg-accent", c === component && "bg-accent text-primary")}>{c.name}</button>
            ))}
          </div>
        ))}
      </nav>
      {component ? (
        <section className="flex min-w-0 flex-col gap-4 overflow-auto">
          <h2 className="text-lg font-semibold">{component.name}</h2>
          {component.description && <p className="text-muted-foreground">{component.description}</p>}
          {component.diagnostics.map((d) => <p key={d} role="alert" className="text-destructive">{d}</p>)}
          {story && (storybook === false
            ? <EmptyState title="Storybook is not running" className="rounded-lg border border-border"><Code>pnpm --filter {component.package} storybook</Code></EmptyState>
            : <iframe title={`${component.name}: ${story.name}`} src={previewUrl(STORYBOOK, story.id, edits)} className="h-70 w-full rounded-lg border border-border bg-card" />)}
          <div role="group" aria-label="Stories" className="flex flex-wrap gap-x-4 gap-y-2">
            {component.stories.map((s, at) => (
              <button key={s.id} type="button" aria-pressed={s === story} disabled={!can({ type: "chooseStory", at })} onClick={() => choose({ type: "chooseStory", at })}
                className={cn("rounded-md px-2 py-1 hover:bg-accent", s === story && "bg-accent text-primary")}>{s.name}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{component.props.map(control)}</div>
          <table className="w-full border-collapse">
            <tbody>
              {component.props.map((p) => (
                <tr key={p.name} className="border-b border-border align-top">
                  <td className="py-1 pr-3"><code className="font-mono text-xs">{p.name + (p.required ? "" : "?")}</code></td>
                  <td className="py-1 pr-3"><code className="font-mono text-xs">{typeOf(p)}</code></td>
                  <td className="py-1 pr-3">{p.default !== undefined && <code className="font-mono text-xs">{JSON.stringify(p.default)}</code>}</td>
                  <td className="py-1">{p.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {component.model && <Code>{`${component.model.state}\n${component.model.events.join("  ")}`}</Code>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {[...(component.model ? [component.model.spec] : []), ...(component.design ?? []), `${component.source.file}:${component.source.line}`].map((path) => <File key={path} path={path} />)}
          </div>
        </section>
      ) : <EmptyState title="No components yet" />}
    </div>
  );
}
