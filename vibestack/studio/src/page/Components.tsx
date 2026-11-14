// The Components view: every React component the story generator found, its generated stories as live previews,
// and its links to the spec model, source and design document. It reads the catalog `vibestack/stories/cli.ts gen`
// writes (vibestack/stories/meta.ts declares the same shape), as the server collects it from the project.
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, ManagedRuntime, Stream } from "effect";
import { Input, cn } from "@repo/ui";
import { Machine, machine } from "../../gen/components.effect.vibe";
import { enabled, initial, type Event } from "../../gen/components.ts";
import { S, select } from "./studio.ts";
import { Code } from "./text.tsx";
import type { Component, ComponentIndex, Prop } from "../catalog.ts";

type Arg = string | number | boolean;

/** Where Storybook serves previews when the catalog does not say: `pnpm storybook`'s port. */
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
const Link = ({ onClick, href, children }: { onClick?: () => void; href?: string; children: string }) =>
  href ? <a href={href} className="font-mono text-xs text-primary">{children}</a>
    : <button type="button" onClick={onClick} className="font-mono text-xs text-primary">{children}</button>;

/** A component's model or design document, opened in the Specs view if it is one of the project's specs. */
const open = (path: string) => { if (S.specs.some((s) => s.file === path)) select(path); };

/** The generated catalog's selected preview. @model spec/components.md */
export function Components({ index }: { index: ComponentIndex }) {
  const storybook = index.storybook.url || STORYBOOK;
  const sourceUrl = (file: string) => encodeURI(`vscode://file/${S.snap!.project.root.replaceAll("\\", "/").replace(/^\/+/, "")}/${file}`);
  const [query, setQuery] = useState("");
  const runtimeRef = useRef<ManagedRuntime.ManagedRuntime<Machine, never> | null>(null);
  const [selection, setSelection] = useState(initial);
  const [edits, setEdits] = useState<Record<string, Arg>>({});
  const catalogKey = JSON.stringify(index.components.map((c) => [c.id, c.stories.map((s) => s.id)]));
  const send = useCallback((event: Event) => runtimeRef.current?.runFork(Effect.flatMap(Effect.service(Machine), (catalog) => catalog.send(event))), []);
  useEffect(() => {
    const active = ManagedRuntime.make(machine());
    runtimeRef.current = active;
    const updates = active.runFork(Effect.flatMap(Effect.service(Machine), (catalog) => Stream.runForEach(catalog.changes, (next) => Effect.sync(() => { setSelection(next); setEdits({}); }))));
    return () => { runtimeRef.current = null; updates.interruptUnsafe(); void active.dispose(); };
  }, []);
  useEffect(() => {
    const entries = JSON.parse(catalogKey) as [string, string[]][];
    send({ type: "load", counts: entries.map(([, stories]) => stories.length), key: catalogKey });
  }, [catalogKey, send]);
  const component = index.components[selection.component];
  const story = component?.stories[selection.story];
  // spec/components.md, "Choosing a component selects its first story and clears prop overrides"; spec/components.md, "Choosing a story stays within its component and clears prop overrides"
  const choose = send;
  const found = matching(index, query);

  const control = (p: Prop) => {
    const current = edits[p.name] ?? story?.args[p.name] ?? p.default;
    const set = (v: Arg) => setEdits({ ...edits, [p.name]: v });
    const field = "rounded-md border border-input bg-background px-2 py-1";
    if (p.kind === "boolean") return <label key={p.name} className="flex items-center gap-2"><input type="checkbox" checked={current === true} onChange={(e) => set(e.target.checked)} />{p.name}</label>;
    if (p.options?.every(isArg)) return (
      <label key={p.name} className="flex items-center gap-2">{p.name}
        <select className={field} value={String(current)} onChange={(e) => set(p.options![e.target.selectedIndex])}>{p.options.map((o) => <option key={String(o)}>{String(o)}</option>)}</select>
      </label>);
    if (p.kind === "number" || p.kind === "string") return (
      <label key={p.name} className="flex items-center gap-2">{p.name}
        <input className={field} type={p.kind === "number" ? "number" : "text"} value={isArg(current) ? String(current) : ""}
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
              <button key={c.id} type="button" aria-current={c === component} disabled={!enabled(selection, { type: "chooseComponent", at: index.components.indexOf(c) })} onClick={() => choose({ type: "chooseComponent", at: index.components.indexOf(c) })}
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
          {story && <iframe title={`${component.name}: ${story.name}`} src={previewUrl(storybook, story.id, edits)} className="h-70 w-full rounded-lg border border-border bg-card" />}
          <div role="group" aria-label="Stories" className="flex flex-wrap gap-x-4 gap-y-2">
            {component.stories.map((s, at) => (
              <button key={s.id} type="button" aria-pressed={s === story} disabled={!enabled(selection, { type: "chooseStory", at })} onClick={() => choose({ type: "chooseStory", at })}
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
            {component.model && <Link onClick={() => open(component.model!.spec)}>{component.model.spec}</Link>}
            {(component.design ?? []).map((d) => <Link key={d} href={sourceUrl(d.split("#")[0])}>{d}</Link>)}
            <Link href={sourceUrl(`${component.source.file}:${component.source.line}`)}>{`${component.source.file}:${component.source.line}`}</Link>
          </div>
        </section>
      ) : <p className="text-muted-foreground">No components yet</p>}
    </div>
  );
}
