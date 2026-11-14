// The manifest of what a publish changed since the agent last synced, and the prompt that hands it to an agent.
import fs from "node:fs";
import path from "node:path";
import { parseSpec, readSpecs, specName, type Spec } from "../../parse.ts";
import { dependencies } from "../../review.ts";
import { codeDirs, danglingCitations, filesUnder } from "../../util.ts";
import { itemsOf, nodeId, nodesOfOutline, outlineOf, SIGN } from "./markdown.ts";

// --- identity: which node of the baseline a node of the current specs is -----------------------------

/** A story or rule, in one spec, under the key the review ledger uses (review.ts, `pendingKey`). */
export interface Node { id: string; file: string; key: string; kind: "story" | "rule"; parent?: string; heading: string; prose: string; quint: string }
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The stories and rules of a spec's text; rules before the first story belong to no story. */
export function nodesOf(file: string, text: string): Node[] {
  return nodesOfOutline(file, outlineOf(file, text)).flatMap(({ id, key, story, rule, parent }): Node[] => {
    if (!rule) return story.origin ? [{ id, file, key, kind: "story", heading: story.title.trim(), prose: collapse(story.body), quint: "" }] : [];
    const items = itemsOf(rule.body);
    return [{
      id, file, key, kind: "rule", parent, heading: rule.title.trim(),
      prose: collapse(items.filter((i) => !i.quint).map((i) => i.text).join("\n")),
      quint: items.filter((i) => i.quint).map((i) => i.text.split("\n").map((l) => l.trimEnd()).join("\n").trim()).join("\n\n"),
    }];
  });
}

/** Which baseline node each current node is, or null for one added since. */
export type Ids = Record<string, string | null>;

// --- the manifest ---------------------------------------------------------------------------------

export interface Change {
  action: "added" | "deleted" | "changed";
  kind: "spec" | "story" | "rule";
  spec: string;
  key: string;
  /** What happened to it: "renamed from …", "prose", "quint", "moved", … */
  what: string[];
  /** What the agent must do about it, in the words of the sync skill. */
  todo: string[];
}
export interface Manifest {
  published: string;
  changes: Change[];
  /** Specs whose generated code and proofs are rebuilt, and why. */
  regenerate: { spec: string; gen: string; why: string }[];
  /** Hand-written code that imports a regenerated module: the `types` stage checks it against the new contract. */
  code: string[];
  /** Tests and shell code that cite a story or rule the specs no longer have. */
  citations: string[];
}

const TODO = {
  storyAdded: "Story → rules: write one ### rule for each thing it requires, each with its Quint; add a `sometimes` rule for each new kind of state it makes possible",
  storyChanged: "Check that its rules say everything the story now asks for; write the missing ones",
  storyDeleted: "Check that its rules moved with it or went too, and that nothing relies on what they defined",
  ruleAdded: "Rule → model: write Quint that says exactly what the sentence says, and no more",
  ruleFormal: "Read its prose and Quint and make sure they say the same",
  prose: "Rule → model: if the meaning changed, change the Quint to match; if only the wording changed, leave it",
  quint: "Model → rule: rewrite the sentence so that a reader of the prose alone is not misled",
  both: "Prose and Quint both changed: make sure they moved to the same place",
  regrouped: "Check that it belongs to its new story, and that the story it left still has the rules it needs",
  respec: "It moved to another spec: import, or move with it, the definitions it relies on and that rely on it",
  renamed: "Its heading changed, so its review key did: cite it by the new heading in tests and src/",
  ruleDeleted: "Check that no story still depends on it",
};

/** Longest common subsequence of two lists of ids; what is not in it moved. */
function moved(before: string[], after: string[]): Set<string> {
  const n = before.length, m = after.length;
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = before[i] === after[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[i] === after[j]) { kept.add(before[i]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return new Set(after.filter((id) => !kept.has(id)));
}

const specsOf = (root: string, texts: Record<string, string>): Spec[] => {
  try { return readSpecs(root, texts); } catch {
    return Object.entries(texts).flatMap(([file, text]) => { try { return [parseSpec(root, file, text)]; } catch { return []; } });
  }
};

/** What changed between the specs as the agent last synced them and as they are now, with what each change asks for. */
export function manifestOf(root: string, baseline: Record<string, string>, current: Record<string, string>, ids: Ids): Manifest {
  const before = Object.entries(baseline).flatMap(([f, t]) => nodesOf(f, t));
  const after = Object.entries(current).flatMap(([f, t]) => nodesOf(f, t));
  const was = new Map(before.map((n) => [n.id, n]));
  const baseOf = (n: Node) => { const b = n.id in ids ? ids[n.id] : n.id; return b === null ? undefined : was.get(b); };
  const changes: Change[] = [];
  const add = (c: Omit<Change, "todo">, todo: string[]) => changes.push({ ...c, todo });

  for (const f of Object.keys(current)) if (!(f in baseline)) add({ action: "added", kind: "spec", spec: f, key: f, what: [] }, ["A new spec: its stories and rules are listed below"]);
  for (const f of Object.keys(baseline)) if (!(f in current)) add({ action: "deleted", kind: "spec", spec: f, key: f, what: [] }, ["The spec and proof file are gone: review its removal and code in src/ and tests that import gen/" + specName(f) + ".ts or cite it"]);
  for (const [file, text] of Object.entries(current)) if (file in baseline && text !== baseline[file]) {
    const was = outlineOf(file, baseline[file]);
    const now = outlineOf(file, text);
    if (was.title !== now.title || was.body !== now.body) add({ action: "changed", kind: "spec", spec: file, key: file, what: ["title or introduction"] }, ["Review the spec's title, introduction and links to other specs"]);
  }

  // Order: each list of siblings, as baseline ids, against the same list in the baseline.
  const byId = new Map(after.map((n) => [n.id, n]));
  const baseId = (n: Node | undefined) => (n ? baseOf(n)?.id : undefined);
  const group = (nodes: Node[], key: (n: Node) => string | undefined, id: (n: Node) => string) => {
    const lists = new Map<string, string[]>();
    for (const n of nodes) { const k = key(n); if (k) lists.set(k, [...(lists.get(k) ?? []), id(n)]); }
    return lists;
  };
  const beforeKids = group(before, (n) => n.parent ?? n.file, (n) => n.id);
  const shuffled = new Set<string>();
  for (const [k, list] of group(after.filter((n) => baseId(n)), (n) => (n.parent ? baseId(byId.get(n.parent)) : n.file), (n) => baseId(n)!)) {
    const original = (beforeKids.get(k) ?? []).filter((id) => list.includes(id));
    for (const id of moved(original, list.filter((id) => original.includes(id)))) shuffled.add(id);
  }

  const gone = new Set(before.map((n) => n.id));
  const quintChanged = new Set<string>();
  for (const n of after) {
    const b = baseOf(n);
    if (!b) {
      add({ action: "added", kind: n.kind, spec: n.file, key: n.key, what: [] }, [n.kind === "story" ? TODO.storyAdded : n.quint ? TODO.ruleFormal : TODO.ruleAdded]);
      continue;
    }
    gone.delete(b.id);
    const what: string[] = [];
    const todo: string[] = [];
    if (b.heading !== n.heading) { what.push(`renamed from "${b.heading}"`); todo.push(TODO.renamed); }
    if (b.file !== n.file) { what.push(`moved from ${b.file}`); todo.push(TODO.respec); }
    const parentBase = n.parent ? baseId(byId.get(n.parent)) : undefined;
    if (n.kind === "rule" && b.file === n.file && parentBase !== b.parent) { what.push(`moved from "${was.get(b.parent!)?.heading ?? "the top"}"`); todo.push(TODO.regrouped); }
    else if (shuffled.has(b.id)) what.push("reordered");
    const prose = b.prose !== n.prose, quint = b.quint !== n.quint;
    if (prose) what.push(n.kind === "story" ? "text" : "prose");
    if (quint) { what.push("quint"); quintChanged.add(b.id); }
    if (n.kind === "story" && prose) todo.push(TODO.storyChanged);
    if (n.kind === "rule") todo.push(...(prose && quint ? [TODO.both] : prose ? [TODO.prose] : quint ? [TODO.quint] : []));
    if (what.length) add({ action: "changed", kind: n.kind, spec: n.file, key: n.key, what }, todo);
  }
  for (const id of gone) {
    const b = was.get(id)!;
    add({ action: "deleted", kind: b.kind, spec: b.file, key: b.key, what: [] }, [b.kind === "story" ? TODO.storyDeleted : TODO.ruleDeleted]);
    if (b.kind === "rule") quintChanged.add(id);
  }

  // Rules that relied on the Quint of a rule that changed or went: their sentences may no longer be true.
  const baseSpecs = specsOf(root, baseline);
  for (const spec of baseSpecs) for (const rule of spec.rules) {
    const relied = dependencies(spec, rule, baseSpecs).filter((d) => quintChanged.has(nodeId(d.spec.file, d.rule.key)));
    if (!relied.length) continue;
    const now = after.find((n) => baseId(n) === nodeId(spec.file, rule.key));
    if (!now) continue;
    const names = relied.flatMap((d) => [...d.names]).join(", ");
    const todo = `It relies on ${names}, whose Quint changed or went: check that its sentence is still true of them, and that it still typechecks`;
    const existing = changes.find((c) => c.kind === "rule" && c.spec === now.file && c.key === now.key && c.action !== "deleted");
    if (existing) existing.todo.push(todo);
    else changes.push({ action: "changed", kind: "rule", spec: now.file, key: now.key, what: [`relies on ${names}`], todo: [todo] });
  }

  // Every spec whose text changed is generated again, and every spec that imports one of those.
  const specs = specsOf(root, current);
  const regenerate: Manifest["regenerate"] = [];
  const edited = Object.keys(current).filter((f) => current[f] !== baseline[f]);
  const visit = (spec: Spec, why: string) => {
    if (regenerate.some((r) => r.spec === spec.file)) return;
    regenerate.push({ spec: spec.file, gen: `gen/${spec.name}.ts`, why });
    for (const s of specs) if (s.imports.includes(spec.name)) visit(s, `imports ${spec.name}`);
  };
  for (const s of specs) if (edited.includes(s.file)) visit(s, "edited");
  const modules = new Set(regenerate.map((r) => r.gen.slice(4, -3)).concat(Object.keys(baseline).filter((f) => !(f in current)).map(specName)));
  const code = codeDirs(root).flatMap((dir) => [`${dir}src`, `${dir}test`]).flatMap((dir) => filesUnder(root, dir))
    .filter((f) => {
      if (!/\.(?:[cm]?tsx?|vibe)$/.test(f)) return false;
      const text = fs.readFileSync(path.join(root, f), "utf8");
      return [...modules].some((m) => [".ts", ".effect.vibe", ".conformance.ts"].some((ext) => text.includes(`gen/${m}${ext}`)));
    });
  let citations: string[] = [];
  try { citations = codeDirs(root).flatMap((dir) => danglingCitations(root, specs, dir)); } catch { /* no code to read */ }
  return { published: new Date().toISOString(), changes, regenerate, code, citations };
}

// --- the prompt ---------------------------------------------------------------------------------

/** The sync request for an agent, at most `limit` characters; the whole manifest is in `.studio/manifest.json`. @throws {never} */
export function promptFor(m: Manifest | undefined, { skill, check }: { skill: string; check: string }, limit = Infinity): string {
  const head = [
    `Sync the specs: follow the sync skill in ${skill}, after reading AGENTS.md in full.`,
    m ? "I published these changes from the spec studio; the full manifest, with what each asks of you, is in .studio/manifest.json." : "",
    `Run \`${check}\` until only review items and obligations you could not prove are left, then stop and report as the skill says. Do not run accept, and do not edit .studio/.`,
  ].filter(Boolean).join("\n");
  if (!m) return head;
  const lines = [
    ...m.changes.map((c) => `${SIGN[c.action]} ${c.kind} ${c.kind === "spec" ? c.key : `${c.spec}: ${c.key}`}${c.what.length ? ` (${c.what.join("; ")})` : ""}`),
    ...(m.regenerate.length ? [`Regenerate: ${m.regenerate.map((r) => r.gen).join(", ")}`] : []),
    ...(m.code.length ? [`Check against the new contract: ${m.code.join(", ")}`] : []),
    ...(m.citations.length ? [`Citations to update: ${m.citations.join("; ")}`] : []),
  ];
  let text = `${head}\n\n${lines.join("\n")}`;
  if (text.length <= limit) return text;
  const more = (n: number) => `\n… and ${n} more in .studio/manifest.json`;
  for (let n = lines.length - 1; n >= 0; n--) {
    text = `${head}\n\n${lines.slice(0, n).join("\n")}${more(lines.length - n)}`;
    if (text.length <= limit) return text;
  }
  return head.slice(0, limit);
}
