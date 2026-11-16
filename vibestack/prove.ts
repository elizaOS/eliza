// The proof stage for one unit: LemmaScript turns the unit's TypeScript into
// Dafny, the tools add what they generate and what the unit's proof file
// supplies, LemmaScript checks that nothing generated was changed and runs
// Dafny, and `dafny audit` checks that nothing added is trusted rather than
// proved.
//
// Counting is per obligation. Dafny first verifies each definition whole, with
// no error limit; a definition that fails is verified again with every
// assertion isolated, so that no failure hides another. Because a postcondition
// that fails is still assumed while the ones after it are checked, each of
// those is then checked again on its own. A failure in a definition's body,
// such as an assertion, is assumed after it, so every obligation of that
// definition is counted as not proved. A lemma that calls a lemma with a
// failing postcondition assumes it, so every obligation of such a lemma is
// counted as not proved too.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SENDER } from "./gen/classify.ts";
import { NEEDS_DAFNY, bin, exec, run } from "./run.ts";
import { plainText } from "./scan.ts";

/** The library of general lemmas that proof files call as ProofLib.<Name>. */
export const LIB_FILE = path.join(import.meta.dirname, "proof", "lib.dfy");
/** The one name the library adds to a unit. */
const LIB_MODULE = "ProofLib";
const RESOURCE_LIMIT = 30_000_000;
/**
 * How Dafny is run. No error limit: no failure hides another. A resource limit,
 * not a time limit: the same answer on any machine; it applies to a definition
 * whole, and to each assertion when a definition is verified again isolated
 * (`verifyAgain`). The time limit only stops a run that would never end.
 * Source lines are not echoed: a proof file's text must never be read back as
 * one of Dafny's own messages.
 */
// run.ts shares the machine's slots between units; each verifier consumes one.
const DAFNY_FLAGS = ["--cores", "1", "--error-limit", "0", "--resource-limit", String(RESOURCE_LIMIT), "--show-snippets:false"];
const TIME_LIMIT = 600;
/** Flags for every Dafny command on a unit's file. */
const dafnyFlags = (dfy: string) => [...(dfy.includes("Std.") ? ["--standard-libraries"] : []), "--unicode-char:true"];
/** How an obligation is named: its definition, without `_ensures`, and its clause. */
const obligationKey = (def: string, clause: string) => `${def.replace(/_ensures$/, "")}: ${clause}`;
/** The clause of an `ensures` line; undefined for any other line. */
const ensured = (line: string) => line.match(/^\s*ensures\b\s*(.*)$/)?.[1].trimEnd();
/** The last lines of a tool's output, on one line. */
const lastLines = (out: string) => out.trim().split("\n").slice(-3).join(" / ");

/** The solver selected by Dafny's installation, pinned for every proof and recorded in its cache key. */
let selected: Promise<{ path: string; version: string }> | undefined;
export function solver(): Promise<{ path: string; version: string }> {
  return selected ??= (async () => {
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
      .flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext))).find((file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
    const candidates: string[] = [];
    const dafny = onPath("dafny");
    if (dafny) {
      const real = fs.realpathSync(dafny);
      for (const dir of [path.dirname(real), path.join(path.dirname(real), "..", "libexec")]) {
        const bundled = path.join(dir, "z3", "bin");
        if (!fs.existsSync(bundled)) continue;
        const preferred = (name: string) => name.includes("4.12.1") ? 0 : name.includes("4.8.5") ? 1 : 2;
        candidates.push(...fs.readdirSync(bundled).filter((name) => /^z3(-\d+(\.\d+)*)?(\.exe)?$/.test(name))
          .sort((a, b) => preferred(a) - preferred(b) || a.localeCompare(b)).map((name) => path.join(bundled, name)));
      }
    }
    const executable = onPath("z3");
    if (executable) candidates.push(executable);
    for (const candidate of candidates) {
      try {
        const result = await exec(candidate, ["--version"], path.dirname(candidate));
        const version = result.status === 0 && result.stdout.match(/Z3 version (\d+\.\d+\.\d+)/)?.[1];
        if (version) return { path: fs.realpathSync(candidate), version };
      } catch { /* try the next solver supplied by this installation */ }
    }
    throw new Error("the proof stage needs the Z3 solver bundled with Dafny or on the PATH");
  })().catch((e) => { selected = undefined; throw e; });
}

/** The version of Dafny on the PATH, read once it is read without a problem, or why it could not be read. */
let dafny: Promise<{ version?: string; problem?: string }> | undefined;
export function dafnyVersion(): Promise<{ version?: string; problem?: string }> {
  return (dafny ??= exec("dafny", ["--version"], process.cwd()).then((r) => {
    const version = r.status === 0 ? r.stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
    const problem = !version ? `Dafny could not be run (${`${r.stdout}${r.stderr}`.trim().split("\n")[0] || "it printed no version"})`
      : !version.startsWith("4.11.") ? `this is Dafny ${version}, and LemmaScript targets Dafny 4.11.x` : undefined;
    return { version, problem: r.stopped ?? (problem && `${problem}: ${NEEDS_DAFNY} (see README, "Getting started")`) };
  }, (e: Error) => ({ problem: `Dafny could not be run (${e.message}): ${NEEDS_DAFNY} (see README, "Getting started")` }))
    .then((r) => { if (r.problem) dafny = undefined; return r; }));
}

// --- proof files ---------------------------------------------------------------

/**
 * Words a proof file may not use. Each declares something other than a lemma,
 * asks Dafny to trust or skip something, or reaches outside the unit.
 */
const FORBIDDEN = new Set(`
  assume expect include import module abstract refines extern function predicate method constructor datatype
  codatatype type newtype const class trait iterator opaque ghost twostate least greatest static export provides
  reveals print modify modifies reads axiom verify colemma inductive
`.split(/\s+/).filter(Boolean));
const ATTRIBUTES = new Set(["trigger", "induction"]);

const STRING = /"(?:[^"\\\n]|\\.)*"/y;
const ATTR = /\{\s*:\s*([A-Za-z_]\w*)?/y;
const WORD = /[A-Za-z_][\w'?]*/y;
const sticky = (re: RegExp, text: string, at: number) => { re.lastIndex = at; return re.exec(text); };

interface Token { t: string; kind: "word" | "open" | "attr" | "close" | "other"; at: number; end: number; line: number }

/**
 * Dafny's tokens, as far as they matter here: comments and whitespace dropped,
 * strings kept whole, `{:` attributes told apart from braces. With `refuse`,
 * anything a proof file may not contain is refused where it appears.
 */
function tokenize(text: string, refuse?: (line: number, why: string) => never): Token[] {
  const out: Token[] = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith("//", i)) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (text.startsWith("/*", i)) {
      if (refuse) refuse(line, "block comments are not allowed; use //");
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      line += text.slice(i, end).split("\n").length - 1;
      i = end;
      continue;
    }
    let kind: Token["kind"] = "other";
    let t = ch;
    if (ch === '"') {
      const m = sticky(STRING, text, i);
      if (m) t = m[0];
      else if (refuse) refuse(line, "a string is not closed on its line");
    } else {
      if (refuse) {
        if (ch === "@") refuse(line, "`@` is not allowed: attributes and verbatim strings could change what is checked");
        if (ch === "'") refuse(line, "character literals are not allowed");
        if (/[^\x20-\x7e]/.test(ch)) refuse(line, "outside comments and strings only ASCII is allowed");
      }
      const attr = ch === "{" && sticky(ATTR, text, i);
      const word = !attr && sticky(WORD, text, i);
      if (attr) {
        if (refuse && !ATTRIBUTES.has(attr[1] ?? "")) refuse(line, `the attribute {:${attr[1] ?? ""}} is not allowed; only ${[...ATTRIBUTES].map((a) => `{:${a}}`).join(" and ")}`);
        [kind, t] = ["attr", attr[0]];
      } else if (ch === "{") kind = "open";
      else if (ch === "}") kind = "close";
      else if (word) {
        if (refuse && FORBIDDEN.has(word[0])) refuse(line, `\`${word[0]}\` is not allowed in a proof file`);
        [kind, t] = ["word", word[0]];
      }
    }
    out.push({ t, kind, at: i, end: i + t.length, line });
    i += t.length;
  }
  return out;
}

/** One lemma of a proof file. */
interface Lemma { name: string; line: number; header: string; headerText: string; body: string; text: string }

/**
 * Words after which a brace starts an operand, such as the set display in `decreases {0}` or `x in {1}`, never a
 * body. A brace starts a lemma's body only after a token that can end a header: `)`, `]`, `}`, the `|` that closes
 * `|xs|`, a number, a string or any other word. Where that still reads an operand as a body (`| {x}` in a
 * comprehension), the lemma really has none, and Dafny's warning about it fails the unit.
 */
const OPERAND_AFTER = new Set("in requires ensures decreases then else returns by set iset multiset seq map imap calc assert var if match case forall exists old fresh reveal lemma".split(" "));
const endsHeader = (t: Token | undefined) => !!t && (t.kind === "close" || /^[)\]|0-9"]/.test(t.t) || (t.kind === "word" && !OPERAND_AFTER.has(t.t)));

/**
 * A proof file holds only `lemma` declarations, each with a body, and `//`
 * comments. Anything else is refused with the file and line. A lemma runs to
 * the next `lemma`; its body is the brace group it ends with, which must follow
 * a complete header.
 */
export function parseProofFile(source: string, file: string): Lemma[] {
  const text = plainText(file, source);
  const refuse = (line: number, why: string): never => { throw new Error(`${file}:${line}: ${why}`); };
  const toks = tokenize(text, refuse);
  const lemmas: Lemma[] = [];
  for (let p = 0; p < toks.length; ) {
    const start = toks[p];
    if (start.kind === "close") refuse(start.line, "unbalanced braces: this } closes nothing");
    if (start.t !== "lemma") refuse(start.line, `only \`lemma\` declarations and // comments may appear at the top level, not \`${start.t}\``);
    let q = p + 1;
    // Attributes may come before the name.
    for (let depth = 0; toks[q] && (toks[q].kind === "attr" || depth > 0); q++) {
      if (toks[q].kind === "attr" || toks[q].kind === "open") depth++;
      else if (toks[q].kind === "close") depth--;
    }
    const name = toks[q]?.kind === "word" ? toks[q].t : refuse(start.line, "a lemma needs a name");
    // Where the last brace group at the top level of the lemma opens; any other token at the top level resets it.
    let open = -1;
    let end = q + 1;
    let depth = 0;
    for (; end < toks.length && toks[end].t !== "lemma"; end++) {
      const k = toks[end];
      if (k.kind === "open" || k.kind === "attr") { if (depth++ === 0) open = k.kind === "open" ? end : -1; }
      else if (k.kind === "close") { if (--depth < 0) refuse(k.line, "unbalanced braces: this } closes nothing"); }
      else if (depth === 0) open = -1;
    }
    if (depth > 0) refuse(start.line, `lemma ${name}: unbalanced braces, its body is never closed`);
    if (open < 0 || !endsHeader(toks[open - 1])) refuse(start.line, `lemma ${name} has no body; every lemma must be proved, and end with its body`);
    if (lemmas.some((l) => l.name === name)) refuse(start.line, `lemma ${name} is declared twice`);
    const close = end - 1;
    lemmas.push({
      name, line: start.line,
      header: toks.slice(p, open).map((t) => t.t).join(" "),
      headerText: text.slice(start.at, toks[open].at).replace(/\s+/g, " ").trim(),
      body: text.slice(toks[open].end, toks[close].at),
      text: text.slice(start.at, toks[close].end),
    });
    p = end;
  }
  return lemmas;
}

/** Each dotted name a Dafny text uses, such as `Std.Collections.Seq.Filter`, from its first word; comments and strings are not names. */
function dottedNames(toks: Token[]): { name: string; first: Token; inner: boolean }[] {
  const out: { name: string; first: Token; inner: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const inner = toks[i - 1]?.t === ".";
    if (toks[i].kind !== "word" || (inner && toks[i - 2]?.kind === "word")) continue;
    const parts = [toks[i].t];
    for (let j = i; toks[j + 1]?.t === "." && toks[j + 2]?.kind === "word"; j += 2) parts.push(toks[j + 2].t);
    out.push({ name: parts.join("."), first: toks[i], inner });
  }
  return out;
}

/**
 * A proof file may reach Dafny's standard library only by a name the generated
 * code itself uses, since the library holds axioms, and the library of the
 * tools only by the lemmas and functions it declares.
 */
function checkNames(proof: { file: string; text: string }, gen: string, lib: string | undefined) {
  const used = new Set(dottedNames(tokenize(gen)).map((d) => d.name));
  const std = [...used].filter((n) => n.startsWith("Std."));
  const own = new Set((lib ?? "").split("\n").flatMap((line) => { const d = declarationAt(line); return d && LIBRARY_KINDS.has(d.kind) ? [d.name] : []; }));
  for (const d of dottedNames(tokenize(proof.text.replace(/\r\n/g, "\n")))) {
    const parts = d.name.split(".");
    const at = `${proof.file}:${d.first.line}`;
    const misplaced = parts.find((p, i) => (i > 0 || d.inner) && (p === "Std" || p === LIB_MODULE));
    if (misplaced) throw new Error(`${at}: \`${misplaced}\` may only begin a name`);
    if (parts[0] === "Std" && !used.has(d.name))
      throw new Error(`${at}: \`${d.name}\` is not allowed: Dafny's standard library holds axioms, so a proof file may use only the names of it that the generated code uses${std.length ? ` (${std.join(", ")})` : ", and it uses none"}`);
    if (parts[0] === LIB_MODULE && !(parts.length === 2 && own.has(parts[1])))
      throw new Error(`${at}: \`${d.name}\` is not a lemma or function of vibestack/proof/lib.dfy; call those as ${LIB_MODULE}.<Name>`);
  }
}

const DECLARATION = /^(\s*)(?:ghost\s+)?(function|predicate|lemma|method|datatype|codatatype|type|newtype|const|class|trait|module)\s+(?:\{:[^}]*\}\s*)*([A-Za-z_][\w']*)/;
/** The declaration a line of Dafny starts, if it starts one: how far it is indented, its kind and its name. */
function declarationAt(line: string): { indent: number; kind: string; name: string } | undefined {
  const m = line.match(DECLARATION);
  return m ? { indent: m[1].length, kind: m[2], name: m[3] } : undefined;
}
/** What the library may declare, and a proof file call of it. */
const LIBRARY_KINDS = new Set(["lemma", "function", "predicate"]);

/** Every name a Dafny text declares at the top level, constructors of its datatypes included. */
function declaredNames(dfy: string): Set<string> {
  const names = new Set<string>();
  for (const line of dfy.split("\n")) {
    const d = declarationAt(line);
    if (!d || d.indent) continue; // inside a declaration or a module
    names.add(d.name);
    const data = line.match(/^(?:co)?datatype\s+\w+(?:<[^>]*>)?\s*=(.*)$/);
    if (data) for (const c of data[1].matchAll(/(?:^|\|)\s*([A-Za-z_][\w']*)/g)) names.add(c[1]);
  }
  return names;
}

/** The generated `<fn>_ensures` lemmas with an empty body: where each one's header ends, its lines and its tokens. */
function emptyLemmas(gen: string): Map<string, { bodyAt: number; lines: string; header: string; headerText: string }> {
  const found = new Map<string, { bodyAt: number; lines: string; header: string; headerText: string }>();
  for (const m of gen.matchAll(/^lemma (\w+_ensures)\([^\n]*\n(?:(?!\{\n)[^\n]*\n)*?(?=\{\n\}\n)/gm))
    found.set(m[1], { bodyAt: m.index + m[0].length, lines: m[0], header: tokenize(m[0]).map((t) => t.t).join(" "), headerText: m[0].replace(/\s+/g, " ").trim() });
  return found;
}

/** The names of a parameter list: each is the word before a `:` at the top level; the `>` of an arrow `->` closes nothing. */
function parameterNames(params: string): string[] {
  const toks = tokenize(params);
  let depth = 0;
  return toks.filter((t, i) => {
    const arrow = t.t === ">" && toks[i - 1]?.t === "-" && toks[i - 1].end === t.at;
    if (!arrow) depth += "<([".includes(t.t) ? 1 : ">)]".includes(t.t) ? -1 : 0;
    return !depth && t.kind === "word" && toks[i + 1]?.t === ":" && (!i || toks[i - 1].t === ",");
  }).map((t) => t.t);
}

/**
 * Where a proof starts (.claude/skills/prove/SKILL.md, "To prove an obligation"): each generated lemma that still has no body and an
 * obligation not proved, under its exact header. A transition's opens on what its first clause assumes, `inv` and the
 * guard, with the state after it; any other is empty.
 */
function scaffold(dfy: string, failing: ReadonlySet<string>, transitions: string[]): string {
  return [...emptyLemmas(dfy)].filter(([name]) => failing.has(name)).map(([name, { lines }]) => {
    const fn = name.replace(/_ensures$/, "");
    const [first, ...rest] = lines.trimEnd().split("\n");
    const assumed = (rest.flatMap((l) => ensured(l) ?? [])[0] ?? "").replace(/^\((.*)\)$/, "$1").split(" ==> ").slice(0, -1);
    const body = transitions.includes(fn) && assumed.length
      ? `  if ${assumed.join(" && ")} {\n    var after := ${fn}(${parameterNames(first.slice(first.indexOf("(") + 1, first.lastIndexOf(")"))).join(", ")});\n  }\n` : "";
    return `${lines}{\n${body}}\n`;
  }).join("\n");
}

interface Additions {
  /** The unit's proof file, if it has one: where it is, and its text. */
  proof?: { file: string; text: string };
  /** The body the tools give `step_ensures` when the proof file does not. */
  stepBody?: string;
  /** Lemmas the tools add: what the units this one imports proved, each in its own unit (importedAxioms), and the laws assumed of opaque functions (assumedAxioms). */
  axioms: { name: string; text: string }[];
  /** The library, added when there is a proof file. */
  lib?: string;
}

/**
 * A definition of the final Dafny, as the tools placed it: one generated by
 * LemmaScript (with any body the proof file supplied), or one added after the
 * generated text (a law of a dependency, a helper, the library).
 */
interface Region { def: string; generated: boolean; prelude?: boolean }
/** The final Dafny, and for each of its lines (line n at index n - 1) the definition it belongs to. */
interface Spliced { dfy: string; regions: Region[] }

/**
 * For each line of generated Dafny, the definition it belongs to: each declaration starts one, which runs to the next.
 * A declaration that is not callable, such as a datatype or a constant, is a definition without obligations.
 */
function regionsOf(gen: string, prelude: ReadonlySet<string>): Region[] {
  let region: Region = { def: "?", generated: false };
  return gen.split("\n").map((line) => {
    const d = declarationAt(line);
    if (d) region = { def: d.name, generated: true, ...(prelude.has(d.name) ? { prelude: true } : {}) };
    return region;
  });
}

/**
 * The library declarations the proof names, with every library declaration they use, each with the comments and
 * blank lines above it. Unknown layouts stay whole.
 */
export function libraryFor(lib: string, proof: string): string | undefined {
  const wanted = dottedNames(tokenize(proof)).filter((name) => name.name.startsWith(`${LIB_MODULE}.`)).map((name) => name.name.split(".")[1]);
  if (!wanted.length) return undefined;
  const lines = lib.trimEnd().split("\n");
  const members = lines.flatMap((line, at) => { const d = declarationAt(line); return d?.indent === 2 ? [{ ...d, at }] : []; });
  if (!members.length || lines.at(-1) !== "}" || !lines.slice(0, members[0].at).includes(`module ${LIB_MODULE} {`)
      || members.some((d) => !LIBRARY_KINDS.has(d.kind))) return lib;
  const note = (line: string) => /^\s*(?:\/\/|\/\*\*|\*|$)/.test(line);
  const starts = members.map(({ name, at }, i) => {
    while (at > (members[i - 1]?.at ?? 0) + 1 && note(lines[at - 1])) at--;
    return { name, at };
  });
  const chunks = new Map(starts.map(({ at, name }, i) => [name, lines.slice(at, starts[i + 1]?.at ?? lines.length - 1).join("\n")]));
  if (wanted.some((name) => !chunks.has(name))) return lib;
  const keep = new Set<string>();
  for (const queue = [...wanted]; queue.length;) {
    const name = queue.pop()!;
    if (keep.has(name)) continue;
    keep.add(name);
    for (const token of tokenize(chunks.get(name)!)) if (token.kind === "word" && chunks.has(token.t) && !keep.has(token.t)) queue.push(token.t);
  }
  return [...lines.slice(0, starts[0].at), ...starts.filter(({ name }) => keep.has(name)).map(({ name }) => chunks.get(name)!), "}", ""].join("\n");
}

/**
 * The final Dafny for a unit: what LemmaScript generated, with the bodies the
 * proof file supplies inside the empty generated lemmas, and after it the
 * tools' lemmas, the proof file's helpers and the library. Only lines are
 * added; nothing generated changes. Each line is recorded with the definition
 * it belongs to, so that a failure is charged to where it really is.
 */
export function splice(gen: string, { proof, stepBody, axioms, lib }: Additions, where = "gen/proof/<unit>/<unit>.dfy", prelude: ReadonlySet<string> = new Set()): Spliced {
  const lemmas = proof ? parseProofFile(proof.text, proof.file) : [];
  const empty = emptyLemmas(gen);
  const bodies = new Map<string, string>();
  const helpers: Lemma[] = [];
  const taken = declaredNames([gen, ...axioms.map((a) => a.text)].join("\n"));
  taken.add(LIB_MODULE);
  for (const l of lemmas) {
    const generated = empty.get(l.name);
    if (generated) {
      if (generated.header !== l.header)
        throw new Error(`${proof!.file}:${l.line}: lemma ${l.name} does not repeat its generated header, so it is refused as stale; copy the header again from ${where}\n  generated: ${generated.headerText}\n  yours:     ${l.headerText}`);
      bodies.set(l.name, l.body.replace(/^[ \t]*\n/, "").trimEnd());
    } else if (taken.has(l.name)) {
      throw new Error(`${proof!.file}:${l.line}: lemma ${l.name}: the name is already declared in ${where}; a helper needs a name of its own`);
    } else helpers.push(l);
  }
  if (proof) checkNames(proof, gen, lib);
  const usedLibrary = lib && proof ? libraryFor(lib, proof.text) : undefined;
  if (stepBody && empty.has("step_ensures") && !bodies.has("step_ensures")) bodies.set("step_ensures", stepBody);
  const lines: string[] = [];
  const regions: Region[] = [];
  const add = (text: string, region: Region) => { for (const l of text.split("\n")) { lines.push(l); regions.push(region); } };
  // The line of each empty generated lemma's `{`, after which its body goes.
  const opens = new Map([...empty].map(([name, { bodyAt }]) => [gen.slice(0, bodyAt).split("\n").length - 1, name]));
  const genRegions = regionsOf(gen, prelude);
  gen.split("\n").forEach((line, i) => {
    add(line, genRegions[i]);
    const body = bodies.get(opens.get(i) ?? "");
    if (body) add(body, genRegions[i]);
  });
  const tail: [string, Region][] = [
    ...axioms.map((a, i): [string, Region] => [`${i ? "" : "// ---- taken as given: what the units this one imports proved, each in its own unit, and the laws of opaque functions (added by the tools) ----\n\n"}${a.text}`, { def: a.name, generated: false }]),
    ...helpers.map((h, i): [string, Region] => [`${i ? "" : `// ---- helpers from ${proof!.file} ----\n\n`}${h.text}`, { def: h.name, generated: false }]),
    ...(usedLibrary ? [[`// ---- vibestack/proof/lib.dfy ----\n\n${usedLibrary.trimEnd()}`, { def: LIB_MODULE, generated: false }] as [string, Region]] : []),
  ];
  if (tail.length) {
    while (lines.length && !lines.at(-1)!.trim()) { lines.pop(); regions.pop(); }
    lines[lines.length - 1] = lines.at(-1)!.trimEnd();
    for (const [text, r] of tail) add(`\n${text}`, r);
    add("", genRegions.at(-1)!);
  }
  return { dfy: lines.join("\n"), regions };
}

/** The header of a top-level definition, from its declaration to before the `{` line of its body; empty if it has none. */
function header(dfy: string, name: string): string[] {
  const lines = dfy.split("\n");
  const start = lines.findIndex((l) => { const d = declarationAt(l); return d?.indent === 0 && d.name === name; });
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && (l === "{" || declarationAt(l)?.indent === 0));
  return end < 0 || lines[end] !== "{" ? [] : lines.slice(start, end);
}
/** The clauses of a generated definition, as an obligation not proved names them after `<definition>: ` (obligationKey). */
export const ensuresOf = (dfy: string, name: string) => header(dfy, name).flatMap((l) => ensured(l) ?? []);

/**
 * An `_ensures` lemma of an imported module, `<fn>_ensures` as this unit spells it, and which of its clauses its own
 * unit proved; all of them when `proved` is absent.
 */
export interface Offered { fn: string; proved?: boolean[] }

/**
 * The lemmas that make what imported units proved usable here. `gen` is the imported modules with their obligations,
 * as this unit spells them, so each lemma is the one LemmaScript generated there, with its `requires` and only the
 * clauses proved. They must be as many as in the module's own unit, or the lemma is not offered.
 */
function importedAxioms(gen: string, offered: Offered[]): Additions["axioms"] {
  return offered.flatMap(({ fn, proved }) => {
    const [first, ...rest] = header(gen, `${fn}_ensures`);
    const clauses = rest.filter((l) => ensured(l) !== undefined).length;
    if (!clauses || (proved && (proved.length !== clauses || !proved.some(Boolean)))) return [];
    let i = 0;
    return [{ name: `${fn}_ensures`, text: [first.replace(/^lemma /, "lemma {:axiom} "), ...rest.filter((l) => ensured(l) === undefined || (proved?.[i++] ?? true))].join("\n") }];
  });
}

/**
 * The laws assumed of the unit's opaque functions (SPEC.md, "Opaque functions"), each as a lemma `<law>_ensures`
 * without a body, from the law's function as LemmaScript generated it.
 */
function assumedAxioms(gen: string, laws: string[]): Additions["axioms"] {
  return laws.map((law) => {
    const params = gen.match(new RegExp(`^function ${law}\\((.*)\\): bool$`, "m"))?.[1];
    if (params === undefined) throw new Error(`the law ${law} is not a function \`${law}(...): bool\` of the generated Dafny, so ${law}_ensures cannot be stated`);
    return { name: `${law}_ensures`, text: `lemma {:axiom} ${law}_ensures(${params})\n  ensures ${law}(${parameterNames(params).join(", ")})` };
  });
}

// --- reading what Dafny said -----------------------------------------------------

interface Verdict { unproved: Map<string, string>; exhausted: Set<string>; errors: Set<string>; failing: Map<string, Set<number>> }

/** Dafny's closing line: how many it verified, and how many failures of each kind it reported. */
const SUMMARY = /^Dafny program verifier finished with \d+ verified, (\d+) errors?((?:, \d+ [a-z ]+)*)$/gm;
const FINISHED = new RegExp(SUMMARY.source, "m");
const finished = (out: string) => FINISHED.test(out);

/**
 * Sort Dafny's messages about `file` into obligations not proved (keyed by
 * definition and clause), obligations it ran out of resources on, and errors.
 * A message counts only at the start of a line and with the bare file name
 * (Dafny runs in the unit's directory, without echoing source lines); a
 * postcondition is taken only from the error's own block and definition. A
 * failure in the body of a generated definition, such as an assertion, fails
 * every obligation of that definition. A failure anywhere but in a generated
 * definition (a helper, the library, a lemma the tools add) is an error: the
 * proof itself is broken. So is a count of failures that differs from the one
 * Dafny reports, and any error from a run that never reached verification,
 * such as a name that does not resolve.
 */
export function readVerdict(out: string, dfy: string, file: string, regions: Region[], rename = (n: string) => n): Verdict {
  const lines = out.split("\n");
  const source = dfy.split("\n");
  const own = `${file}(`;
  const pattern = /^\((\d+),\d+\): (Error|Warning|Related location): (.*)$/;
  const messages = lines.map((l) => {
    const m = l.startsWith(own) ? l.slice(file.length).match(pattern) : null;
    return m ? { line: Number(m[1]), kind: m[2], what: m[3] } : undefined;
  });
  const defAt = (line: number) => regions[line - 1]?.def ?? "?";
  const clause = (line: number) => { const l = source[line - 1] ?? ""; return ensured(l) ?? l.trim(); };
  const verified = finished(out);
  const v: Verdict = { unproved: new Map(), exhausted: new Set(), errors: new Set(), failing: new Map() };
  const fail = (line: number, text: string, exhausted: boolean) => {
    const r = regions[line - 1];
    if (r?.prelude) { v.errors.add(`${r.def} (${file}:${line}), one of LemmaScript's own helpers, does not verify: ${text}; it is not an obligation of the unit`); return; }
    if (!r?.generated) { v.errors.add(`${r?.def ?? "?"} (${file}:${line}) does not verify: ${text}; a lemma that is not generated must prove`); return; }
    const def = rename(r.def);
    const k = obligationKey(def, text);
    v.unproved.set(k, def);
    if (exhausted) v.exhausted.add(k);
    if (!v.failing.has(def)) v.failing.set(def, new Set());
    v.failing.get(def)!.add(line);
  };
  /** A failure in a definition's body, which is assumed after it: every `ensures` of the definition's header fails. */
  const failBody = (line: number, what: string, exhausted: boolean) => {
    const r = regions[line - 1];
    if (!r?.generated || r.prelude) return fail(line, what, exhausted);
    const { obligations } = definitionLines(source, regions, r.def);
    if (!obligations.length) v.errors.add(`${rename(r.def)}: ${what}`);
    for (const i of obligations) fail(i + 1, clause(i + 1), exhausted);
  };
  let read = 0;
  lines.forEach((l, i) => {
    const m = messages[i];
    if (!m) {
      if (!l.startsWith(own) && /^Error:|: Error:/.test(l)) v.errors.add(l.trim());
      return;
    }
    if (m.kind === "Error") read++;
    if (m.kind === "Error" && m.what.startsWith("a postcondition could not be proved")) {
      const block: { line: number; what: string }[] = [];
      for (let j = i + 1; messages[j]?.kind === "Related location"; j++) block.push(messages[j]!);
      const related = block.find((r) => r.what.includes("postcondition") && regions[r.line - 1] && regions[r.line - 1] === regions[m.line - 1]);
      if (related) fail(related.line, clause(related.line), false);
      else v.errors.add(`${defAt(m.line)}: ${m.what}, and Dafny named no postcondition of it: ${clause(m.line)}`);
    } else if (m.kind === "Error" && /timed out/.test(m.what)) {
      v.errors.add(`${defAt(m.line)}: Dafny stopped after ${TIME_LIMIT} s of wall-clock time (machine load), not a verdict`);
    } else if (m.kind === "Error" && /out of resource/.test(m.what) && ensured(source[m.line - 1] ?? "") !== undefined) {
      fail(m.line, clause(m.line), true);
    } else if (m.kind === "Error" && verified) failBody(m.line, `${m.what}: ${clause(m.line)}`, /out of resource/.test(m.what));
    else if (m.kind === "Error") v.errors.add(`${defAt(m.line)}: ${m.what}: ${clause(m.line)}`);
    else if (m.kind === "Warning") v.errors.add(`${defAt(m.line)}: ${m.what}`);
  });
  const reported = [...out.matchAll(SUMMARY)].reduce((n, s) => n + Number(s[1]) + [...s[2].matchAll(/\d+/g)].reduce((a, x) => a + Number(x[0]), 0), 0);
  if (verified && reported !== read) v.errors.add(`Dafny reported ${reported} failures, but ${read} were read from its output`);
  return v;
}

const verifyArgs = (dfy: string, solverPath: string) => ["verify", ...dafnyFlags(dfy), ...DAFNY_FLAGS, "--verification-time-limit", String(TIME_LIMIT), "--solver-path", solverPath];

/** A generated definition's lines (0-based), the `{` that opens its body, and the `ensures` before it. */
function definitionLines(lines: string[], regions: Region[], def: string) {
  const own = lines.flatMap((_, i) => regions[i]?.generated && !regions[i].prelude && regions[i].def === def ? [i] : []);
  const open = own.find((i) => i > own[0] && lines[i] === "{");
  return { own, open, obligations: own.filter((i) => i < (open ?? Infinity) && ensured(lines[i]) !== undefined) };
}

/** A copy of a generated definition: its name, the definition it copies, its lines, and the line of the unit's Dafny each copies. */
interface Copy { name: string; def: string; lines: string[]; origin: number[] }

/**
 * Copies of generated definitions, named apart with `prefix` so that a filter verifies only them. For each definition,
 * `wanted` picks from the lines of its `ensures` (in the unit's Dafny) the ones each copy keeps, one list per copy.
 * A definition whose declaration cannot be read is never copied: the obligations a copy of it would check are
 * `closed`, counted as not proved, and one that cannot be found is an error.
 */
export function isolatedCopies({ dfy, regions }: Spliced, wanted: Map<string, (ensures: number[]) => number[][]>, prefix = "isolated"): { copies: Copy[]; closed: Map<string, string>; errors: string[] } {
  const lines = dfy.split("\n");
  const copies: Copy[] = [];
  const closed = new Map<string, string>();
  const errors: string[] = [];
  for (const [def, pick] of wanted) {
    const { own, open, obligations } = definitionLines(lines, regions, def);
    if (!own.length) { errors.push(`${def}: cannot locate the generated definition to verify it again`); continue; }
    const start = own[0];
    const shaped = open !== undefined && declarationAt(lines[start])?.name === def;
    const keeps = pick(obligations.map((i) => i + 1));
    let body: string[] | undefined;
    if (shaped) {
      const rest = lines.slice(open, own.at(-1)! + 1).join("\n");
      let depth = 0;
      const close = tokenize(rest).find((t) => (t.kind === "open" || t.kind === "attr" ? (depth++, false) : t.kind === "close" ? --depth === 0 : false));
      if (close) body = rest.slice(0, close.end).split("\n");
    }
    for (const keep of keeps) {
      if (!body) {
        for (const line of keep) closed.set(obligationKey(def, ensured(lines[line - 1])!), def);
        continue;
      }
      const name = `${prefix}${copies.length}_${def}`;
      const header = Array.from({ length: open! - start }, (_, i) => start + i).filter((i) => ensured(lines[i]) === undefined || keep.includes(i + 1));
      copies.push({
        name, def,
        lines: [lines[start].replace(new RegExp(`\\b${def}\\b`), name), ...header.slice(1).map((i) => lines[i]), ...body],
        origin: [...header.map((i) => i + 1), ...body.map((_, j) => open! + 1 + j)],
      });
    }
  }
  return { copies, closed, errors };
}

/** Add what one verdict found to another. */
function absorb(into: Verdict, from: Verdict) {
  for (const [k, def] of from.unproved) into.unproved.set(k, def);
  for (const k of from.exhausted) into.exhausted.add(k);
  for (const e of from.errors) into.errors.add(e);
  for (const [def, at] of from.failing) into.failing.set(def, new Set([...(into.failing.get(def) ?? []), ...at]));
}

/**
 * Verify copies of generated definitions (`isolatedCopies`) in one run of Dafny, every assertion isolated. The verdict
 * names the originals, at their own lines; `copied` is the definitions that were copied.
 */
async function verifyAgain(dir: string, spliced: Spliced, file: string, tag: string, wanted: Map<string, (ensures: number[]) => number[][]>, solverPath: string): Promise<{ verdict: Verdict; log: string; copied: Set<string> }> {
  const { dfy, regions } = spliced;
  let prefix = tag;
  while (dfy.includes(prefix)) prefix = `x${prefix}`;
  const { copies, closed, errors } = isolatedCopies(spliced, wanted, prefix);
  const failedClosed: Verdict = { unproved: closed, exhausted: new Set(), errors: new Set(errors), failing: new Map() };
  if (!copies.length) return { verdict: failedClosed, log: "", copied: new Set() };
  const derived = dfy.trimEnd().split("\n");
  const derivedRegions = regions.slice(0, derived.length);
  /** For each derived line, the line of the unit's Dafny it copies. */
  const origin = derived.map((_, i) => i + 1);
  for (const c of copies) {
    const region: Region = { def: c.name, generated: true };
    ["", ...c.lines].forEach((l, i) => { derived.push(l); derivedRegions.push(region); origin.push(i ? c.origin[i - 1] : 0); });
  }
  const name = file.replace(/\.dfy$/, `.${tag}.dfy`);
  const text = `${derived.join("\n")}\n`;
  fs.writeFileSync(path.join(dir, name), text);
  const csv = name.replace(/\.dfy$/, ".csv");
  fs.rmSync(path.join(dir, csv), { force: true });
  const { out } = await run("dafny", [...verifyArgs(text, solverPath), "--isolate-assertions", "--log-format", `csv;LogFileName=${csv}`, "--filter-symbol", prefix, name], dir);
  const copyOf = new Map(copies.map((c) => [c.name, c.def]));
  const verdict = readVerdict(out, text, name, derivedRegions, (n) => copyOf.get(n) ?? n);
  verdict.failing = new Map([...verdict.failing].map(([def, at]) => [def, new Set([...at].map((l) => origin[l - 1]))]));
  absorb(verdict, failedClosed);
  const rows = fs.existsSync(path.join(dir, csv)) ? fs.readFileSync(path.join(dir, csv), "utf8").split("\n").slice(1) : [];
  const checked = new Set(rows.map((row) => {
    const cells = row.match(/^"((?:[^"]|"")*)",|^([^,]*),/);
    return (cells?.[1]?.replace(/""/g, '"') ?? cells?.[2] ?? "").replace(/ \(.*$/, "");
  }));
  for (const c of copies) if (!checked.has(c.name)) verdict.errors.add(`${c.def}: Dafny did not check ${c.name}, its copy verified again`);
  if (!finished(out)) verdict.errors.add(`the definitions verified again gave no verdict: ${lastLines(out)}`);
  return { verdict, log: out, copied: new Set(copies.map((c) => c.def)) };
}

/**
 * The definitions that rest on an obligation not proved: a lemma assumes every
 * postcondition of each lemma it calls, so one that calls a lemma with a failing
 * postcondition, or a lemma that does, proves nothing more than that one does.
 * Calls are read conservatively, as any mention of the name. Returns, for each
 * such definition, one obligation it rests on.
 */
function restingOn({ dfy, regions }: Spliced, unproved: Map<string, string>): Map<string, string> {
  const texts = new Map<Region, string[]>();
  dfy.split("\n").forEach((l, i) => { const t = texts.get(regions[i]); if (t) t.push(l); else texts.set(regions[i], [l]); });
  // What each definition mentions besides its own declaration; a second mention of its own name is a call to itself.
  const mentions = new Map<string, string[]>();
  for (const [r, t] of texts) {
    const words = tokenize(t.join("\n")).filter((k) => k.kind === "word").map((k) => k.t);
    if (words.includes(r.def)) words.splice(words.indexOf(r.def), 1);
    mentions.set(r.def, [...(mentions.get(r.def) ?? []), ...words]);
  }
  const failing = new Map<string, string>();
  for (const [k, def] of unproved) if (!failing.has(def)) failing.set(def, k);
  const rests = new Map<string, string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [def, words] of mentions) {
      if (rests.has(def)) continue;
      const callee = words.find((w) => failing.has(w) || rests.has(w));
      if (callee) { rests.set(def, failing.get(callee) ?? rests.get(callee)!); changed = true; }
    }
  }
  return rests;
}

/** Findings of `dafny audit` in the unit's own file, other than the lemmas the tools add on purpose. */
async function audit(dir: string, dfy: string, file: string, allowed: Set<string>): Promise<{ findings: string[]; log: string }> {
  const { ok, out } = await run("dafny", ["audit", ...dafnyFlags(dfy), file], dir);
  const findings = out.split("\n").filter((l) => l.startsWith(`${file}(`) && /: (Warning|Error): /.test(l))
    .filter((l) => !/: Warning: (\w+): Declaration has explicit `\{:axiom\}` attribute/.test(l) || !allowed.has(l.match(/: Warning: (\w+):/)![1]));
  if (!/Dafny auditor completed/.test(out)) findings.push(`dafny audit gave no verdict: ${lastLines(out)}`);
  else if (!ok && !findings.length) findings.push(`dafny audit failed: ${lastLines(out)}`);
  return { findings: findings.map((f) => `dafny audit: ${f}`), log: out };
}

// --- one unit --------------------------------------------------------------------

export interface Proof {
  /** The unit's obligations: the `ensures` of its generated Dafny. */
  total: number;
  /** Obligations not proved, as `<definition>: <clause>`. */
  unproved: string[];
  /** Of those, the ones the prover ran out of resources on. */
  exhausted: string[];
  /** Of those, the ones whose proof calls, directly or not, a lemma with an obligation not proved: each with one such obligation. */
  resting: Record<string, string>;
  errors: string[];
  log: string;
  /** The final Dafny, as it was verified. */
  dfy: string;
  /** The generated lemmas with an obligation not proved and no body yet, each with a body to start from (`scaffold`); empty if there is none. */
  scaffold: string;
}

export interface Unit {
  unit: string;
  text: string;
  /** Hand-written code under src/, whose obligations must be proved: nothing simulates them. */
  src: boolean;
  /** spec/<path>.proof.dfy or src/<path>.proof.dfy, relative to the project. */
  proofFile: string;
  /**
   * The modules this unit imports, as it spells them: their text with their obligations, and each definition with an
   * `_ensures` lemma: `<fn>_ensures` here, `<def>_ensures` in `from`, the unit that proves it.
   */
  imports: { text: string; lemmas: { fn: string; def: string; from: string }[] };
  /** The units whose assurance this one's rests on. */
  rests: string[];
  /** Opaque functions, which the Dafny declares without a body, and the laws assumed of them, which a proof file may call as `<law>_ensures`. */
  externs: string[];
  assumed: string[];
  /** The generated code without comments naming the source rules. */
  meaning: string;
  /** The caller preconditions of hand-written code. */
  requires?: number;
  /** For a state machine: its transitions and the names of the parameters each takes after the state. */
  transitions?: { name: string; params: string[] }[];
}

/**
 * The body the tools give step_ensures: each event is covered by its
 * transition's own lemma, and the prover sees the bodies of `step` and `inv`
 * only: hiding the rest takes facts away, never adds one. Constructors are read
 * from the generated Event type, which spells a name that is a Dafny keyword
 * differently; undefined if the generated text is not as expected.
 */
function stepBody(gen: string, transitions: { name: string; params: string[] }[]): string | undefined {
  const event = gen.match(/^datatype Event = (.*)$/m);
  const constructors = event ? event[1].split("|").map((c) => c.trim().match(/^(\w+)/)?.[1] ?? "") : [];
  if (constructors.length !== transitions.length) return undefined;
  // `by` is a Dafny keyword, so LemmaScript renames it; take its spelling from step_ensures itself.
  const sender = gen.match(/^lemma step_ensures\(current: \w+, event: Event, (\w+):/m)?.[1];
  const cases = transitions.map(({ name, params }, i) => {
    if (!new RegExp(`^lemma ${name}_ensures\\(`, "m").test(gen)) return undefined;
    // The event carries every parameter but `by` (who sent it), which step_ensures takes beside it (gen/typescript.ts).
    if (params.includes(SENDER) && !sender) return undefined;
    const bound = params.filter((p) => p !== SENDER).map((p) => `i_${p}`);
    const args = params.map((p) => (p === SENDER ? sender : `i_${p}`));
    return `    case ${constructors[i]}${bound.length ? `(${bound.join(", ")})` : ""} => ${name}_ensures(${["current", ...args].join(", ")});`;
  });
  return cases.every(Boolean) ? ["  hide *;", "  reveal step, inv;", "  match event {", ...cases, "  }"].join("\n") : undefined;
}

/** LemmaScript's own generated helpers are runtime support, not obligations the user may accept as simulated. */
let helpers: Promise<ReadonlySet<string>> | undefined;
function helperNames(root: string): Promise<ReadonlySet<string>> {
  return helpers ??= (async () => {
    const lsc = bin("lsc", root);
    const real = fs.realpathSync(lsc);
    // pnpm's executable is a shell shim; the declared dependency still resolves beside this package.
    let dependency: string | undefined;
    try { dependency = createRequire(import.meta.url).resolve("lemmascript/tools/dist/dafny-emit.js"); } catch { /* use the executable's installation below */ }
    const file = [path.join(path.dirname(real), "dafny-emit.js"), path.join(path.dirname(lsc), "..", "lemmascript", "tools", "dist", "dafny-emit.js"), dependency].find((f): f is string => f !== undefined && fs.existsSync(f));
    if (!file) throw new Error("LemmaScript's dafny-emit.js was not found beside lsc");
    const names = (await import(pathToFileURL(file).href)).DAFNY_HELPER_NAMES;
    if (!(names instanceof Set)) throw new Error("LemmaScript's dafny-emit.js does not export DAFNY_HELPER_NAMES");
    return names as ReadonlySet<string>;
  })();
}

/** Where a unit's proof is written: its directory, Dafny's full output, the final Dafny, and the lemmas left to prove. */
export function proofPaths(unit: string) {
  const base = unit.replace(/\.ts$/, "");
  return { dir: `gen/proof/${base}`, log: `gen/proof/${base}.log`, dfy: `gen/proof/${base}/${base}.dfy`, scaffold: `gen/proof/${base}/${base}.scaffold.dfy` };
}

/** Prove one unit in a directory of its own, so that nothing left over from another run or project can vouch for it. */
export async function prove(root: string, u: Unit, offered: { proof?: { file: string; text: string }; lib?: string; axioms: Offered[] }): Promise<Proof> {
  const where = proofPaths(u.unit);
  const dir = path.join(root, where.dir);
  const file = path.basename(where.dfy);
  fs.rmSync(dir, { recursive: true, force: true });
  const place = (at: string, text: string) => {
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, u.unit), text);
    // A configuration of our own, so that one further up cannot redirect the proof or relax it, and a TypeScript
    // project of our own, so that the project's tsconfig.json cannot add files, globals or options to it.
    fs.writeFileSync(path.join(at, "lemmascript.json"), JSON.stringify({ "unread-annotations": "error", "run-log": false }));
    fs.writeFileSync(path.join(at, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "es2023", lib: ["es2023"], module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] },
      files: [u.unit],
    }));
  };
  place(dir, u.text);
  let total = 0;
  const result = (errors: string[], log: string, dfy = ""): Proof => ({ total, unproved: [], exhausted: [], resting: {}, errors, log, dfy, scaffold: "" });
  // What imported units proved, and the library, are only of use to a proof file. The imported modules are generated
  // again beside the unit, with their obligations, for the lemmas that state them.
  const importing = offered.proof && offered.axioms.length ? path.join(dir, "imported") : undefined;
  if (importing) place(importing, u.imports.text);
  const lsc = async (at: string) => {
    const { ok, out } = await run("lsc", ["gen", "--backend=dafny", u.unit], at);
    const genFile = path.join(at, `${file}.gen`);
    return { out, gen: ok && fs.existsSync(genFile) ? fs.readFileSync(genFile, "utf8") : undefined };
  };
  const [generated, imported] = await Promise.all([lsc(dir), importing ? lsc(importing) : undefined]);
  for (const g of [generated, imported]) if (g && !g.gen) return result([lastLines(g.out) || "lsc generated nothing"], g.out);
  const gen = generated.gen!;
  const prelude = await helperNames(root);
  const selectedSolver = await solver();
  const genRegions = regionsOf(gen, prelude);
  total = gen.split("\n").filter((line, i) => ensured(line) !== undefined && !genRegions[i].prelude).length;
  let axioms: Additions["axioms"];
  let spliced: Spliced;
  try {
    axioms = [...(imported ? importedAxioms(imported.gen!, offered.axioms) : []), ...(offered.proof ? assumedAxioms(gen, u.assumed) : [])];
    spliced = splice(gen, { proof: offered.proof, lib: offered.proof && offered.lib, axioms, stepBody: u.transitions && stepBody(gen, u.transitions) }, where.dfy, prelude);
  } catch (e) {
    return result([(e as Error).message], generated.out);
  }
  const axiomNames = new Set([...axioms.map((a) => a.name), ...u.externs]);
  const { dfy } = spliced;
  fs.writeFileSync(path.join(dir, file), dfy);
  // LemmaScript checks the exact generated-output relationship; Dafny verifies the same file with the pinned solver.
  const [audited, integrity, checked] = await Promise.all([
    audit(dir, dfy, file, axiomNames),
    run("lsc", ["gen-check", "--backend=dafny", u.unit], dir),
    run("dafny", [...verifyArgs(dfy, selectedSolver.path), file], dir),
  ]);
  let log = `solver: Z3 ${selectedSolver.version} (${selectedSolver.path})\n${generated.out}${integrity.out}${checked.out}`;
  const v = readVerdict(checked.out, dfy, file, spliced.regions);
  if (!integrity.ok) v.errors.add(`LemmaScript refused the final Dafny: ${lastLines(integrity.out)}`);
  // The verdict is Dafny's own summary; without it, or with anything left unexplained, the unit was not checked.
  if (!v.errors.size && (!finished(checked.out) || (!checked.ok && !v.unproved.size))) v.errors.add(lastLines(checked.out) || "Dafny produced no verdict");
  // A definition that fails whole is verified again with every assertion isolated, and that verdict replaces its own.
  if (!v.errors.size && v.failing.size) {
    const isolated = await verifyAgain(dir, spliced, file, "isolated", new Map([...v.failing.keys()].map((def) => [def, (ensures) => [ensures]])), selectedSolver.path);
    log += `\n---- each definition with a failure, every assertion isolated ----\n${isolated.log}`;
    for (const [k, def] of v.unproved) if (isolated.copied.has(def)) { v.unproved.delete(k); v.exhausted.delete(k); }
    for (const def of isolated.copied) v.failing.delete(def);
    absorb(v, isolated.verdict);
  }
  // A failing postcondition is assumed while the later ones are checked: each of those is checked again on its own.
  // (A failure in a body fails every postcondition of its definition: readVerdict.) Not in a definition that rests on
  // another's failure, all of whose obligations are counted as not proved below anyway.
  if (!v.errors.size && v.failing.size) {
    const rests = restingOn(spliced, v.unproved);
    const alone = await verifyAgain(dir, spliced, file, "alone", new Map([...v.failing].filter(([def]) => !rests.has(def)).map(([def, failed]) => [def, (ensures) => {
      const first = Math.min(...failed);
      return ensures.filter((l) => l > first && !failed.has(l)).map((l) => [l]);
    }])), selectedSolver.path);
    if (alone.log) log += `\n---- each postcondition of a definition with a failure, checked on its own ----\n${alone.log}`;
    absorb(v, alone.verdict);
  }
  // Every obligation of a generated definition that rests on one not proved is not proved either.
  const resting: Record<string, string> = {};
  const lines = dfy.split("\n");
  for (const [def, on] of restingOn(spliced, v.unproved))
    for (const i of definitionLines(lines, spliced.regions, def).obligations) {
      const k = obligationKey(def, ensured(lines[i])!);
      v.unproved.set(k, def);
      resting[k] = on;
    }
  const { findings, log: auditLog } = audited;
  log += `\n---- dafny audit ----\n${auditLog}`;
  for (const f of findings) v.errors.add(f);
  return { total, unproved: [...v.unproved.keys()], exhausted: [...v.exhausted], resting, errors: [...v.errors], log, dfy,
    scaffold: scaffold(dfy, new Set(v.unproved.values()), u.transitions?.map((t) => t.name) ?? []) };
}
