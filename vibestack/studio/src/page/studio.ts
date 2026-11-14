// What the page holds: the working copy of every spec and what the server last said. Every edit to a spec is an
// outline event (spec/outline.md), applied only if `enabled` allows it; every action on the project is offered only if
// the session allows it (spec/index.md). The components (./App.tsx) draw this and call its actions.
import { useSyncExternalStore } from "react";
import { enabled as allowed, type Event as SessionEvent, type Session } from "../../gen/index.ts";
import { enabled, step, type Event as Edit, type Outline, type Rule, type Story } from "../../gen/outline.ts";
import { bodyOf, nodeId, nodesOfOutline, specOrder, textBody, textOf, type Item } from "../markdown.ts";
import type { Result } from "../../../spec.ts";
import type { Snapshot } from "../project.ts";
import type { ComponentIndex } from "../catalog.ts";

export type SpecView = Snapshot["specs"][number];
/** One spec as this page holds it: the outline being edited, and what it was when loaded (`base` is its hash on disk). */
export interface Working { file: string; base: string | null; orig: string | null; was: Outline; outline: Outline; deleted: boolean }
/** A story or rule on the page: `<file>#<number>`, or `<file>#head` for the title. */
export const ui = (file: string, id: number | "head") => `${file}#${id}`;

export const S = {
  projects: [] as { id: string; name: string }[],
  project: new URLSearchParams(location.search).get("project") ?? "",
  snap: undefined as Snapshot | undefined,
  specs: [] as Working[],
  sel: "",
  /** Which stories and rules are open, or being edited. */
  open: new Set<string>(),
  editing: new Set<string>(),
  /** The prose and Quint blocks of each rule being edited, while it is edited. */
  items: new Map<string, Item[]>(),
  history: [] as string[],
  conflicts: [] as string[],
  publishing: false,
  /** The project's components (./Components.tsx), if it has a catalog, and which view the page shows. */
  components: undefined as ComponentIndex | undefined,
  view: "specs" as "specs" | "components",
  toast: undefined as { text: string; action?: { label: string; run: () => void } } | undefined,
};

// --- redrawing -------------------------------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
/** Redraw every component that reads the page's state. */
export const redraw = () => { version++; listeners.forEach((l) => l()); };
/** The page's state, redrawn whenever it changes. */
export const useStudio = () => {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
  return S;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, action?: { label: string; run: () => void }) {
  S.toast = { text, action };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = undefined; redraw(); }, action ? 6000 : 2600);
  redraw();
}

// --- the working copy ------------------------------------------------------------------------------------------

const working = (spec: SpecView): Working => ({ file: spec.file, base: spec.hash, orig: spec.text, was: spec.outline, outline: spec.outline, deleted: false });
/** The text a spec would be published as: as it was if nothing changed, tidied if something did. */
export const publishedText = (spec: Working) => {
  if (spec.deleted) return null;
  const text = textOf(spec.outline);
  return text === spec.orig ? text : textOf(spec.outline, true);
};
export const isDirty = (spec: Working) => spec.deleted || spec.orig === null || publishedText(spec) !== spec.orig;
export const dirtySpecs = () => S.specs.filter(isDirty);
/** The session as this page sees it: the server's, and whether there is anything to publish. */
const session = (): Session => ({ ...S.snap!.session, unpublished: dirtySpecs().length > 0 });
export const can = (event: SessionEvent) => !!S.snap && allowed(session(), event);
export const current = () => S.specs.find((s) => s.file === S.sel);
/** A spec's name in the rail: its path below spec/, and its directory for an index. */
export const specLabel = (file: string) => file.slice(5, -3).replace(/(^|\/)index$/, "") || "index";

/** Whether a story or rule differs from what was loaded: new, edited, or somewhere else. */
export function storyChanged(spec: Working, s: Story, i: number) {
  const was = spec.was.stories.findIndex((x) => x.id === s.id);
  return was < 0 || was !== i || spec.was.stories[was].title !== s.title || spec.was.stories[was].body !== s.body;
}
export function ruleChanged(spec: Working, s: Story, r: Rule, j: number) {
  const home = spec.was.stories.find((x) => x.rules.some((y) => y.id === r.id));
  const was = home?.rules.findIndex((y) => y.id === r.id) ?? -1;
  return !home || home.id !== s.id || was !== j || home.rules[was].title !== r.title || home.rules[was].body !== r.body;
}
/** Whether `title` is non-empty and appears once among `titles` (spec/outline.md, "Every story and rule needs a heading, unique where it is"). */
export const soleHeading = (titles: string[], title: string) => !!title && titles.filter((t) => t === title).length === 1;

/** The specs on disk, with the ones this page changed kept, and those that changed on disk underneath them noted. */
function merge(snap: Snapshot, mine: Working[]): Working[] {
  const keys = (specs: Working[]) => new Map(specs.flatMap((w) => nodesOfOutline(w.file, w.outline).map((n) => [n.id, ui(w.file, (n.rule ?? n.story).id)] as const)));
  const before = keys(mine);
  const out: Working[] = [];
  S.conflicts = [];
  for (const d of mine) {
    if (!isDirty(d)) continue;
    if ((snap.specs.find((x) => x.file === d.file)?.hash ?? null) !== d.base) S.conflicts.push(d.file);
    out.push(d);
  }
  for (const f of snap.specs) if (!out.some((o) => o.file === f.file)) out.push(working(f));
  out.sort((a, b) => specOrder(a.file, b.file));
  // A story or rule stays open, or being edited, across a reload: by what it is called, since its number may change.
  const after = keys(out);
  const remap = (id: string) => {
    const key = [...before].find(([, v]) => v === id)?.[0];
    return key ? after.get(key) : id;
  };
  S.open = new Set([...S.open].flatMap((id) => remap(id) ?? []));
  S.editing = new Set([...S.editing].flatMap((id) => remap(id) ?? []));
  S.items = new Map([...S.items].flatMap(([id, v]) => { const to = remap(id); return to ? [[to, v] as const] : []; }));
  return out;
}

// --- the server ------------------------------------------------------------------------------------------------

async function api(route: string, body?: unknown) {
  const res = await fetch(`/api/${route}?project=${encodeURIComponent(S.project)}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? res.statusText), { status: res.status, body: json });
  return json;
}

export async function refresh(published?: { specs: Map<string, { text: string | null; outline: Outline }>; history: number }) {
  if (S.publishing && !published) return;
  const [snap, components]: [Snapshot, ComponentIndex | undefined] = await Promise.all([api("project"), api("components").catch(() => undefined)]);
  if (S.publishing && !published) return;
  const acknowledge = (specs: Working[]) => specs.filter((spec) => {
    const sent = published?.specs.get(spec.file);
    if (!sent) return true;
    if (sent.text === null && spec.deleted) return false;
    const disk = snap.specs.find((s) => s.file === spec.file);
    spec.orig = sent.text;
    spec.was = sent.outline;
    if ((disk?.text ?? null) === sent.text) spec.base = disk?.hash ?? null;
    return true;
  });
  if (published) {
    S.specs = acknowledge(S.specs);
    S.history = S.history.slice(published.history).map((entry) => JSON.stringify(acknowledge(JSON.parse(entry))));
  }
  S.snap = snap;
  S.components = components;
  S.specs = merge(snap, S.specs);
  if (!S.specs.some((s) => s.file === S.sel)) S.sel = S.specs[0]?.file ?? "";
  redraw();
}

/** Ask the server to act; what it refuses, the page says. */
export function start(route: string, body: unknown = {}) {
  api(route, body).catch((e: Error) => toast(e.message));
}

/** Load the projects and the one this page shows, and follow what the server says of it. */
export async function connect() {
  const { projects, open } = await (await fetch("/api/projects")).json();
  S.projects = projects;
  S.project ||= open;
  await refresh();
  const events = new EventSource(`/api/events?project=${encodeURIComponent(S.project)}`);
  events.addEventListener("files", () => { refresh().catch((e: Error) => toast(e.message)); });
  events.addEventListener("job", (e) => {
    const { session, jobs, check, app } = JSON.parse((e as MessageEvent).data);
    const ended = S.snap!.session.job !== "Idle" && session.job === "Idle";
    Object.assign(S.snap!, { session, jobs, check, app });
    if (ended) refresh().catch((error: Error) => toast(error.message));
    else redraw();
  });
}

// --- what the checks say about each story and rule ----------------------------------------------------------------

/** Failing check results by the spec file and the rule key they cite. */
export function failures() {
  const byKey = new Map<string, string[]>();
  const bySpec = new Map<string, Result[]>();
  for (const r of S.snap?.check?.results ?? []) {
    if (r.ok || r.stage === "review" || r.stage === "skipped") continue;
    const file = r.where?.startsWith("spec/") ? r.where : S.snap?.specs.find((s) => `${s.module}.ts` === r.where)?.file;
    if (file) bySpec.set(file, [...(bySpec.get(file) ?? []), r]);
    for (const m of `${r.summary}\n${r.detail}`.matchAll(/"([^"]+)" \((spec\/(?:[a-z][A-Za-z0-9]*\/)*[a-z][A-Za-z0-9]*\.md):\d+\)/g)) {
      const id = nodeId(m[2], m[1]);
      byKey.set(id, [...(byKey.get(id) ?? []), `${r.stage}: ${r.summary}`]);
    }
  }
  return { byKey, bySpec };
}
export const reviewOf = (spec: Working, key: string) => S.snap?.specs.find((s) => s.file === spec.file)?.review[key];
/** Stories and rules waiting for review, in one spec or in all. */
export const reviewCount = (file?: string) => (S.snap?.specs ?? []).filter((s) => !file || s.file === file).reduce((n, s) => n + Object.keys(s.review).length, 0);

// --- edits: outline events -----------------------------------------------------------------------------------------

/** Where a story or rule is now: its spec, and its position (spec/outline.md, "Positions"). */
export function find(id: string) {
  for (const spec of S.specs) for (const [s, story] of spec.outline.stories.entries()) {
    if (ui(spec.file, story.id) === id) return { spec, s, story };
    const r = story.rules.findIndex((x) => ui(spec.file, x.id) === id);
    if (r >= 0) return { spec, s, story, r, rule: story.rules[r] };
  }
}
/** Apply events to a spec's outline, all or none: false, and nothing changed, if the outline refuses one. */
export function apply(spec: Working, ...events: Edit[]) {
  let o = spec.outline;
  for (const e of events) {
    if (!enabled(o, e)) return false;
    o = step(o, e);
  }
  spec.outline = o;
  redraw();
  return true;
}
/** Every change but typing is undoable; typing is undone a whole edit at a time. */
function remember() {
  S.history.push(JSON.stringify(S.specs));
  if (S.history.length > 50) S.history.shift();
}
export function change(fn: () => boolean | void, message?: string) {
  remember();
  if (fn() === false) { S.history.pop(); return toast("The outline does not allow that"); }
  redraw();
  if (message) toast(message, { label: "Undo", run: undo });
}
export function undo() {
  const was = S.history.pop();
  if (!was) return;
  S.specs = JSON.parse(was);
  S.editing.clear();
  S.items.clear();
  redraw();
}

/** Focus after the next redraw, with the caret at the end of any text already there. */
export const focusLater = (selector: string) => setTimeout(() => {
  const el = document.querySelector<HTMLInputElement>(selector);
  el?.focus();
  if (el && "selectionStart" in el && el.value !== undefined) el.selectionStart = el.selectionEnd = el.value.length;
}, 0);

/** Open a story or rule for editing, as one undoable change. */
export function editNode(id: string, undoable = true) {
  if (undoable && !S.editing.has(id)) remember();
  S.editing.add(id);
  S.open.add(id);
  redraw();
  focusLater(`[data-uid="${id}"] input[data-heading]`);
}
/** Stop editing a story or rule; its edits stay in the working copy. */
export function doneEditing(id: string) {
  S.editing.delete(id);
  S.items.delete(id);
  redraw();
}
export function toggle(id: string) {
  if (!S.open.delete(id)) S.open.add(id);
  redraw();
}
export function select(file: string) {
  S.sel = file;
  S.view = "specs";
  redraw();
}

export function addStory(spec: Working) {
  const id = spec.outline.counter;
  change(() => apply(spec, { type: "addStory", at: spec.outline.stories.length, title: "Story:", body: "\n", origin: "" }) && editNode(ui(spec.file, id), false));
}
export function addRule(spec: Working, s: number) {
  const id = spec.outline.counter;
  S.open.add(ui(spec.file, spec.outline.stories[s].id));
  change(() => apply(spec, { type: "addRule", s, at: spec.outline.stories[s].rules.length, title: "", body: "\n", origin: "" }) && editNode(ui(spec.file, id), false));
}
export function removeNode(id: string) {
  const f = find(id);
  if (!f) return;
  change(() => apply(f.spec, f.rule ? { type: "removeRule", s: f.s, r: f.r! } : { type: "removeStory", s: f.s }), `Deleted “${(f.rule ?? f.story).title.trim() || "untitled"}”`);
}
/** A story's heading and text, or a rule's heading and blocks, as one outline event (spec/outline.md). */
export function editStory(id: string, title: string, body: string) {
  const f = find(id);
  if (f) apply(f.spec, { type: "editStory", s: f.s, title, body });
}
export function editRule(id: string, title: string, items = S.items.get(id)!) {
  const f = find(id);
  if (f?.rule) apply(f.spec, { type: "editRule", s: f.s, r: f.r!, title, body: bodyOf(items) });
}
export function retitle(spec: Working, title: string, body: string) {
  apply(spec, { type: "retitle", title, body: textBody(body) });
}

/** The events that put a story, and its rules after it, into another spec at position `at`. */
const storyInto = (at: number, story: Story): Edit[] => [
  { type: "addStory", at, title: story.title, body: story.body, origin: story.origin },
  ...story.rules.map((r, i): Edit => ({ type: "addRule", s: at, at: i, title: r.title, body: r.body, origin: r.origin })),
];

/**
 * Move a story or rule before or after another, into a story, or to the end of another spec: one outline event for
 * a move within a spec, and a removal and additions, keeping each one's key, for a move between specs.
 */
export function move(dragged: string, target: { uid?: string; where?: "before" | "after"; spec?: string }) {
  const from = find(dragged);
  if (!from || dragged === target.uid) return;
  change(() => {
    if (target.spec) {
      const into = S.specs.find((s) => s.file === target.spec)!;
      if (!from.rule) return apply(into, ...storyInto(into.outline.stories.length, from.story)) && apply(from.spec, { type: "removeStory", s: from.s });
      const last = into.outline.stories.length - 1;
      if (last < 0) return false;
      const r = from.rule;
      return apply(into, { type: "addRule", s: last, at: into.outline.stories[last].rules.length, title: r.title, body: r.body, origin: r.origin }) && apply(from.spec, { type: "removeRule", s: from.s, r: from.r! });
    }
    const to = find(target.uid!)!;
    const after = target.where === "after" ? 1 : 0;
    if (to.spec !== from.spec) {
      if (!from.rule) return apply(to.spec, ...storyInto(to.s + after, from.story)) && apply(from.spec, { type: "removeStory", s: from.s });
      const at = to.rule ? to.r! + after : to.story.rules.length;
      const r = from.rule;
      return apply(to.spec, { type: "addRule", s: to.s, at, title: r.title, body: r.body, origin: r.origin }) && apply(from.spec, { type: "removeRule", s: from.s, r: from.r! });
    }
    if (!from.rule) {
      // A story's new position, counted without it.
      const dest = to.s + after - (from.s < to.s + after ? 1 : 0);
      return apply(from.spec, { type: "moveStory", s: from.s, dest });
    }
    const at = to.rule ? to.r! + after - (to.s === from.s && from.r! < to.r! + after ? 1 : 0) : to.story.rules.length - (to.s === from.s ? 1 : 0);
    return apply(from.spec, { type: "moveRule", s: from.s, r: from.r!, dest: to.s, at });
  });
}
export function nudge(id: string, by: number) {
  const f = find(id);
  if (!f) return;
  change(() => apply(f.spec, f.rule ? { type: "moveRule", s: f.s, r: f.r!, dest: f.s, at: f.r! + by } : { type: "moveStory", s: f.s, dest: f.s + by }));
  focusLater(`[data-uid="${id}"] > [data-row]`);
}

/**
 * A new spec at `spec/<path>/index.md`, empty and unpublished, linked from the nearest spec above it, so publishing
 * hands both to the agent (spec/index.md, "Story: Edit, then publish").
 */
export function newSpec(path: string) {
  const file = `spec/${path}/index.md`;
  if (!/^([a-z][A-Za-z0-9]*\/)*[a-z][A-Za-z0-9]*$/.test(path)) return toast("A spec's path is names like billing or billing/payments");
  if (S.specs.some((s) => s.file === file || s.file === `spec/${path}.md`)) return toast(`${file} already exists`);
  const name = path.split("/").pop()!;
  const empty: Outline = { title: name[0].toUpperCase() + name.slice(1), body: "\n", stories: [], counter: 1 };
  change(() => {
    S.specs.push({ file, base: null, orig: null, was: empty, outline: empty, deleted: false });
    const dirs = path.split("/");
    for (let n = dirs.length - 1; n >= 0; n--) {
      const parent = S.specs.find((s) => s.file === `spec/${[...dirs.slice(0, n), "index.md"].join("/")}` && !s.deleted);
      if (!parent) continue;
      retitle(parent, parent.outline.title, `${parent.outline.body.trim()}\n\n[${empty.title}](./${dirs.slice(n).join("/")}/)`);
      break;
    }
    S.sel = file;
  }, `${file} will be written on publish`);
}
export const deleteSpec = (spec: Working, deleted: boolean) => change(() => { spec.deleted = deleted; }, deleted ? `${spec.file} will be deleted on publish` : undefined);

/** A spec changed on disk while this page edits it: keep these edits over it, or take what is on disk. */
export function keepMine(file: string) {
  const fresh = S.snap!.specs.find((s) => s.file === file);
  const mine = S.specs.find((s) => s.file === file)!;
  mine.base = fresh?.hash ?? null;
  mine.orig = fresh?.text ?? null;
  S.conflicts = S.conflicts.filter((f) => f !== file);
  redraw();
}
export function takeTheirs(file: string) {
  const fresh = S.snap!.specs.find((s) => s.file === file);
  S.specs = S.specs.flatMap((s) => (s.file !== file ? [s] : fresh ? [working(fresh)] : []));
  S.conflicts = S.conflicts.filter((f) => f !== file);
  redraw();
}
// spec/index.md, "Edits stay in the page until they are published or discarded"
export const discard = () => change(() => { S.specs = S.snap!.specs.map(working); S.conflicts = []; S.editing.clear(); S.items.clear(); });

// --- publishing ------------------------------------------------------------------------------------------------------

export async function publish(force = false): Promise<void> {
  if (S.publishing) return;
  const dirty = dirtySpecs();
  const submitted = new Map(dirty.map((spec) => [spec.file, { text: publishedText(spec), outline: spec.outline }]));
  const history = S.history.length;
  // What each story and rule was on disk, so the manifest can say what moved and what was renamed.
  const origins = dirty.filter((s) => !s.deleted).flatMap((spec) => nodesOfOutline(spec.file, spec.outline).map((n) => [n.id, (n.rule ?? n.story).origin || null]));
  S.publishing = true;
  try {
    await api("publish", { files: dirty.map((s) => ({ file: s.file, base: s.base, text: submitted.get(s.file)!.text })), origins, force });
  } catch (e: any) {
    S.publishing = false;
    if (e.status === 409 && e.body.conflicts && confirm(`${e.body.conflicts.join(", ")} changed on disk since you loaded it. Overwrite with your version?`)) return publish(true);
    return toast(e.message);
  }
  // spec/index.md, "Edits stay in the page until they are published or discarded"
  try { await refresh({ specs: submitted, history }); }
  catch (e) {
    S.publishing = false;
    return toast(`Published; could not reload: ${(e as Error).message}`);
  }
  S.publishing = false;
  redraw();
  toast("Published");
}
