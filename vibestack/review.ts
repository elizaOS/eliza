import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readSpecs, isStd, bareQuint as bare, heading, type Import, type Spec, type Story, type Rule } from "./parse.ts";
import { short, readSrc, indent, citations, type Citation } from "./util.ts";
import { DECLASSIFY } from "./gen/secrecy.ts";

/**
 * Obligations that hold in simulation but that Dafny cannot prove on its own,
 * accepted by a person: per unit, the list, and a fingerprint of the unit's
 * text and proof file when they were accepted. A list accepted for another
 * text no longer counts.
 */
export interface Accepted { text: string; unproved: string[] }
interface ReviewLock { version: 1; specs: Record<string, Lock>; contracts: Record<string, string>; unproved: Record<string, Accepted> }
export const ledgerFile = (root: string) => path.join(root, "spec/lock.json");
const emptyLock = (): ReviewLock => ({ version: 1, specs: {}, contracts: {}, unproved: {} });

/** One versioned ledger owns review and proof acceptance for the entire spec tree. */
function readReviewLock(root: string): ReviewLock {
  const file = ledgerFile(root);
  if (!fs.existsSync(file)) return emptyLock();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!object(data) || data.version !== 1 || !object(data.specs) || !object(data.contracts) || !object(data.unproved)
    || Object.entries(data.specs).some(([file, rules]) => !/^spec\/.+\.md$/.test(file) || !object(rules) || Object.values(rules).some((v) => !strings(v)))
    || Object.values(data.contracts).some((v) => typeof v !== "string")
    || Object.values(data.unproved).some((v) => !object(v) || typeof v.text !== "string" || !strings(v.unproved)))
    throw new Error("spec/lock.json has an unsupported version or invalid review records");
  return data as unknown as ReviewLock;
}

/** Publish all sections together; an interrupted write cannot leave half a ledger. */
function writeReviewLock(root: string, lock: ReviewLock) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(lock, null, 2) + "\n");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
/** Prose may be re-wrapped without becoming a different sentence. Code may not: a line break can end a comment. */
const proseFingerprint = (prose: string) => short(prose.replace(/\s+/g, " ").trim());
const fingerprint = (r: Rule): [string, string] => [proseFingerprint(r.prose), short(r.code.split("\n").map((l) => l.trimEnd()).join("\n").trim())];
/** A story is recorded under its heading, which no rule's key can be. */
const storyKey = (s: Story) => `## ${s.title}`;
/** Story titles are unique (see parseSpec), so a story's rules are the ones filed under its title. */
const rulesOf = (spec: Spec, s: Story) => spec.rules.filter((r) => r.story === s.title);

/** The identifiers a piece of Quint mentions, outside comments and strings: `A::n` as a qualified pair, every other one bare. */
function mentions(code: string): { bare: Set<string>; qualified: [string, string][] } {
  const qualified: [string, string][] = [];
  const rest = bare(code).replace(/([A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)/g, (_, q, n) => { qualified.push([q, n]); return " "; });
  return { bare: new Set(rest.match(/[A-Za-z_]\w*/g) ?? []), qualified };
}
/** The names a rule's Quint defines: its definitions and types, and the variants of its sum types. */
export function defines(rule: Rule): string[] {
  const variants: string[] = [];
  let inType = false;
  for (const line of bare(rule.code).split("\n")) {
    const declared = line.match(/^\s*(?:pure\s+)?(?:def|val|type|import|var|const)\b/);
    if (declared) inType = /^\s*type\s+\w+\s*=/.test(line);
    if (!inType) continue;
    const after = declared ? line.slice(line.indexOf("=") + 1) : line;
    for (const m of after.matchAll(/(?:^|\|)\s*([A-Z]\w*)\s*(?=\(|\||$)/g)) variants.push(m[1]);
  }
  return [...rule.defs, ...variants];
}
const definedIn = new WeakMap<Spec, Map<string, Rule[]>>();
function namesOf(spec: Spec): Map<string, Rule[]> {
  let names = definedIn.get(spec);
  if (!names) {
    names = new Map();
    for (const r of spec.rules) for (const n of defines(r)) names.set(n, [...(names.get(n) ?? []), r]);
    definedIn.set(spec, names);
  }
  return names;
}

/** A rule whose Quint another rule's Quint relies on, and the names it is relied on for. */
interface Dependency { spec: Spec; rule: Rule; names: Set<string> }

/**
 * The rules whose Quint `rule` relies on, directly or through others, in its own spec and in the specs it imports.
 * A bare name is looked up first in the spec that mentions it, then in the specs that one imports with `.*` or by that
 * name; `A::n` only in the spec imported as `A` (or, if no import is called `A`, as a bare name would be). The scan is
 * conservative: an identifier that happens to share a definition's name counts as a use of it.
 */
export function dependencies(spec: Spec, rule: Rule, specs: Spec[]): Dependency[] {
  const found = new Map<string, Dependency>();
  const homes = (from: Import[], n: string) => from.flatMap((u) => {
    const d = specs.find((x) => x.name === u.module);
    return d ? (namesOf(d).get(n) ?? []).map((x) => [d, x] as const) : [];
  });
  const visit = (s: Spec, r: Rule) => {
    const { bare: names, qualified } = mentions(r.code);
    const unqualified = (n: string) => {
      const own = namesOf(s).get(n);
      return own ? own.map((x) => [s, x] as const) : homes(s.uses.filter((u) => u.star || u.names.includes(n)), n);
    };
    const uses: [string, (readonly [Spec, Rule])[]][] = [...names].map((n) => [n, unqualified(n)]);
    for (const [q, n] of qualified) {
      const via = s.uses.filter((u) => (u.alias ?? u.module) === q);
      uses.push([`${q}::${n}`, via.length ? homes(via, n) : [...unqualified(n), ...homes(s.uses, n)]]);
    }
    for (const [n, at] of uses)
      for (const [ds, dr] of at) {
        if (dr === r || dr === rule) continue;
        const key = `${ds.file}\0${dr.key}`;
        const seen = found.get(key);
        if (seen) { seen.names.add(n); continue; }
        found.set(key, { spec: ds, rule: dr, names: new Set([n]) });
        visit(ds, dr);
      }
  };
  visit(spec, rule);
  return [...found.values()];
}
/** One fingerprint for the Quint of every rule a rule relies on; undefined if it relies on none. */
const dependencyFingerprint = (deps: Dependency[]) =>
  deps.length ? short(deps.map((d) => `${d.spec.name} / ${d.rule.key}: ${fingerprint(d.rule)[1]}`).sort().join("\n")) : undefined;

/**
 * Something a person has to reconcile before the spec can be accepted. `lines` are a story's rules, or a contract's
 * `//@` lines; `cited` is where code cites a changed rule, to read again against it.
 */
export interface Pending { where: string; rule?: Rule; story?: Story; lines?: string[]; status: keyof typeof ASKS; note?: string; cited?: string[] }
const ASKS = {
  "document changed": "confirm the title, introduction and spec links",
  "story has no rules": "write one ### rule for each thing the story requires",
  "new story": "check that its rules say everything it asks for",
  "story changed": "check its rules still say everything it asks for",
  "not formalized": "add a quint block that says what the prose says",
  "new": "confirm the prose and the model say the same thing",
  "prose and model both changed": "confirm they still agree",
  "prose changed": "update the model to match, or confirm it already does",
  "model changed": "update the prose to match, or confirm it already does",
  "removed or renamed": "confirm the rule is meant to be gone",
  "new contract": "confirm its //@ annotations say what the code must guarantee",
  "contract changed": "confirm its //@ annotations still say what the code must guarantee",
  "contract removed": "confirm the file is no longer meant to be proved",
};
export const showPending = (p: Pending) => `${p.where}\n      ${p.status}${p.note ?? ""}: ${ASKS[p.status]}${p.cited?.length ? `\n      cited by ${p.cited.join(", ")}: read them again against it` : ""}`;

export type Lock = Record<string, string[]>;
/** A spec's ledger. `locks` remembers the ones read, for a caller that reads many in a row while none of them changes. */
const readLock = (root: string, spec: Spec, locks: Map<string, Lock>): Lock => {
  const known = locks.get(spec.file);
  if (known) return known;
  const all = readReviewLock(root).specs;
  for (const [file, value] of Object.entries(all)) locks.set(file, value);
  const lock = all[spec.file] ?? {};
  locks.set(spec.file, lock);
  return lock;
};

/** The ledger key an item to reconcile is recorded under. */
export const pendingKey = (p: Pending) => p.rule?.key ?? (p.story ? storyKey(p.story) : p.where.includes("  ") ? p.where.slice(p.where.indexOf("  ") + 2) : "@document");

/**
 * Stories and rules to reconcile since `accept`. A rule's model is its own Quint and that of every rule it relies
 * on (see `dependencies`), so a change to a helper, a type or an imported definition flags every rule that uses it.
 */
export function pending(root: string, spec: Spec, specs: Spec[] = readSpecs(root), locks = new Map<string, Lock>()): Pending[] {
  const lock = readLock(root, spec, locks);
  const out: Pending[] = [];
  let cites: Citation[] | undefined;
  const document = proseFingerprint(spec.preamble);
  if (lock["@document"]?.[0] !== document && (spec.preamble.trim() || lock["@document"]))
    out.push({ where: spec.file, status: "document changed", lines: [spec.preamble.trim()] });
  for (const s of spec.stories) {
    const was = lock[storyKey(s)];
    const status = !rulesOf(spec, s).length ? "story has no rules" : !was ? "new story" : was[0] !== proseFingerprint(s.prose) ? "story changed" : undefined;
    if (status) out.push({ where: `${spec.file}:${s.line}  ${s.title}`, story: s, status, lines: rulesOf(spec, s).map(heading) });
  }
  for (const rule of spec.rules) {
    const [prose, code] = fingerprint(rule);
    const deps = dependencies(spec, rule, specs);
    const was = lock[rule.key];
    const prosed = was && was[0] !== prose;
    const relied = was && was[2] !== dependencyFingerprint(deps);
    const modelled = was && (was[1] !== code || relied);
    const status = !rule.code.trim() ? "not formalized" : !was ? "new"
      : prosed && modelled ? "prose and model both changed" : prosed ? "prose changed" : modelled ? "model changed" : undefined;
    let note: string | undefined;
    if (status && relied) {
      // Name the rules it relies on whose own Quint is not what was recorded for them.
      const changed = deps.filter((d) => readLock(root, d.spec, locks)[d.rule.key]?.[1] !== fingerprint(d.rule)[1]);
      note = changed.length ? ` through ${changed.map((d) => `${[...d.names].join(", ")} (${d.spec === spec ? "" : `${d.spec.file}: `}${d.rule.key})`).join("; ")}`
        : was[1] === code ? (was.length < 3 ? " (what it relies on was not recorded before)" : " through a definition it relies on") : undefined;
    }
    // A way out for a secret is named whenever it is new or changed (gen/secrecy.ts).
    const outlet = rule.defs.filter((d) => DECLASSIFY.test(d));
    if (status && outlet.length) note = `${note ?? ""}, and declassifies a secret through ${outlet.join(", ")}`;
    // A rule whose meaning moved is read again with the tests and shell code that cite it, in every package.
    const cited = status?.includes("changed") ? (cites ??= citations(root)).filter((c) => c.spec === spec.file && c.heading === heading(rule)).map((c) => c.at) : [];
    if (status) out.push({ where: `${spec.file}:${rule.line}  ${rule.key}`, rule, status, note, ...cited.length ? { cited } : {} });
  }
  for (const key of Object.keys(lock))
    if (key !== "@document" && !spec.rules.some((r) => r.key === key) && !spec.stories.some((s) => storyKey(s) === key)) out.push({ where: `${spec.file}  ${key}`, status: "removed or renamed" });
  return out;
}

/** Record every story and rule of a spec as reconciled. */
function reviewed(spec: Spec, specs: Spec[]): Lock {
  // One story or rule per line, in the order of the spec, so a diff of the ledger shows exactly what was re-reviewed.
  const entries = [
    ...spec.stories.map((s) => ({ line: s.line, key: storyKey(s), value: [proseFingerprint(s.prose)] })),
    ...spec.rules.map((r) => {
      const deps = dependencyFingerprint(dependencies(spec, r, specs));
      return { line: r.line, key: r.key, value: deps ? [...fingerprint(r), deps] : fingerprint(r) };
    }),
  ].sort((a, b) => a.line - b.line);
  return { "@document": [proseFingerprint(spec.preamble)], ...Object.fromEntries(entries.map((e) => [e.key, e.value])) };
}

/** Record one spec while preserving the rest of the central ledger. */
export function acceptReviews(root: string, spec: Spec, specs: Spec[] = readSpecs(root)) {
  const lock = readReviewLock(root);
  lock.specs[spec.file] = reviewed(spec, specs);
  writeReviewLock(root, lock);
}

/** Deleted specs remain reviewable until the whole snapshot is accepted. */
export function pendingSpecs(root: string, specs: Spec[]): Pending[] {
  return Object.keys(readReviewLock(root).specs).filter((file) => !specs.some((s) => s.file === file))
    .map((file) => ({ where: file, status: "removed or renamed" }));
}

/**
 * Atomically record the exact spec and source snapshot checked by accept. Every spec, std/ libraries included, is what
 * a rule's dependencies are fingerprinted against, as `pending` does; only the project's own specs are recorded.
 */
export function acceptAllReviews(root: string, specs: Spec[], src = readSrc(root)) {
  const lock = readReviewLock(root);
  lock.specs = Object.fromEntries(specs.filter((spec) => !isStd(spec.file)).map((spec) => [spec.file, reviewed(spec, specs)]));
  lock.contracts = contractLedger(contracts(root, src));
  writeReviewLock(root, lock);
}

// --- the contracts of hand-written verified code ------------------------------------

/**
 * The contract of a file: every `//@` comment line, under the declarations it sits in (`f: //@ requires …`), so that
 * moving an annotation from one function to another changes it. Keep every line containing `//@`, including an
 * annotation after code on the same line; source validation rejects occurrences in strings or block comments.
 */
function contractOf(file: string, code: string): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const named = (n: ts.Node): string | undefined =>
    // A local variable is not a declaration a contract is about; a constant of the file is.
    ts.isVariableStatement(n) ? (ts.isSourceFile(n.parent) ? n.declarationList.declarations.map((d) => d.name.getText(sf)).join(", ") : undefined)
    : (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)
      || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n)) && n.name ? n.name.getText(sf) : undefined;
  /** The names of the declarations around a position, outermost first; a comment belongs to the declaration it leads. */
  const owners = (at: number): string[] => {
    const chain: string[] = [];
    for (let n: ts.Node | undefined = sf; n; ) {
      const inner: ts.Node | undefined = n.getChildren(sf).find((c) => c.getFullStart() <= at && at < c.getEnd());
      const name = inner && named(inner);
      if (name) chain.push(name);
      n = inner;
    }
    return chain;
  };
  const out: string[] = [];
  let at = 0;
  for (const line of code.split("\n")) {
    const text = line.trim();
    if (line.includes("//@")) {
      const owner = owners(at + line.indexOf("//@")).join(".");
      out.push(owner ? `${owner}: ${text}` : text);
    }
    at += line.length + 1;
  }
  return out;
}
/** The contract of every proved src file, under its path from the root: `src/x.ts`, or `apps/app/src/x.ts` in an owner. */
export const contracts = (root: string, src = readSrc(root)) => new Map(src.filter((u) => u.ts).map((u) => [u.file, contractOf(u.file, u.code)]));
/** What the ledger records of every contract: a fingerprint of its lines. */
const contractLedger = (now: ReturnType<typeof contracts>) =>
  Object.fromEntries([...now].map(([file, lines]) => [file, short(lines.join("\n"))]));

/** The `//@` contracts in src/ that are new, changed or gone since `accept`. A file that loses every `//@` is gone. */
export function pendingContracts(root: string, src = readSrc(root)): Pending[] {
  const lock = readReviewLock(root).contracts;
  const now = contracts(root, src);
  const ledger = contractLedger(now);
  const out: Pending[] = [];
  for (const [file, lines] of now) {
    const status = !(file in lock) ? "new contract" : lock[file] !== ledger[file] ? "contract changed" : undefined;
    if (status) out.push({ where: file, status, lines });
  }
  for (const file of Object.keys(lock)) if (!now.has(file)) out.push({ where: file, status: "contract removed" });
  return out;
}

/** Record the `//@` contract of every proved src file as reconciled. */
export function acceptContracts(root: string, src = readSrc(root)) {
  const lock = readReviewLock(root);
  lock.contracts = contractLedger(contracts(root, src));
  writeReviewLock(root, lock);
}

/**
 * Both halves of every rule that has moved, the text and rules of every story that has, and the lines of every new or
 * changed contract, so that whoever reconciles them compares rather than guesses.
 */
export const moved = (todo: Pending[]): string[] => todo.flatMap(({ where, rule, story, lines, status, note }) =>
  rule && (status === "new" || status.includes("changed")) ? [`    "${rule.key}" (${status}${note ?? ""})\n      its prose:\n${indent(rule.prose.trim() || "(only the heading)", 8)}\n      its Quint:\n${indent(rule.code.trim(), 8)}`]
  : story && status !== "story has no rules" ? [`    "${story.title}" (${status})\n      its text:\n${indent(story.prose.trim() || "(only the heading)", 8)}\n      its rules:\n${indent((lines ?? []).join("\n"), 8)}`]
  : !story && lines ? [`    ${where} (${status})\n      ${status === "document changed" ? "its document" : "its //@ lines"}:\n${indent(lines.join("\n"), 8)}`]
  : []);

export function readLedger(root: string): Record<string, Accepted | undefined> {
  return readReviewLock(root).unproved;
}
export function writeLedger(root: string, ledger: Record<string, Accepted>) {
  const lock = readReviewLock(root);
  lock.unproved = ledger;
  writeReviewLock(root, lock);
}

/** Upgrade existing acceptance records without accepting any changed prose, code or proof. */
export function migrateLocks(root: string): string[] {
  const dir = path.join(root, "spec");
  if (!fs.existsSync(dir)) return [];
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".lock.json")).sort();
  if (!files.length) return [];
  if (fs.existsSync(ledgerFile(root))) throw new Error("spec/lock.json and legacy ledgers both exist; resolve them before migrating");
  const lock = emptyLock();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (file === "src.lock.json") lock.contracts = data;
    // An exception in the old list form names no text it was accepted for, so it could never count again: it is dropped.
    else if (file === "unproved.lock.json") lock.unproved = Object.fromEntries(Object.entries(data).filter(([, value]) => !Array.isArray(value)) as [string, Accepted][]);
    else lock.specs[`spec/${file.replace(/\.lock\.json$/, ".md").split(path.sep).join("/")}`] = data;
  }
  writeReviewLock(root, lock);
  // Validate the same schema that check reads before retiring the old records.
  try { readReviewLock(root); } catch (e) { fs.rmSync(ledgerFile(root)); throw e; }
  for (const file of files) fs.rmSync(path.join(dir, file));
  return files.map((f) => `spec/${f}`);
}
