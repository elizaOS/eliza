import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { specName } from "../../parse.ts";
import type { ComponentIndex } from "../../stories/emit.ts";
import type { Citation } from "../../util.ts";
import { itemsOf, outlineOf, ruleKey, storyKey } from "./markdown.ts";

export type RuleRole =
  | "domain"
  | "transition"
  | "always"
  | "step"
  | "sometimes"
  | "leadsTo"
  | "law"
  | "refines"
  | "helper";

export interface GraphNode {
  id: string;
  label: string;
  initial?: boolean;
  goal?: string;
  invariants: string[];
  predicate?: string;
}

export interface GraphEdge {
  id: string;
  name: string;
  from: string;
  to: string;
  guard?: string;
  guardExpr?: string;
  condition?: string;
  sender?: string;
  params: { name: string; type: string }[];
  story: string;
  ruleKey: string;
  ruleHeading: string;
  quint: string;
  liveness?: { rule: string; within?: number; fair?: string };
  selfLoop?: boolean;
}

export interface RuleMeta {
  key: string;
  story: string;
  heading: string;
  role: RuleRole;
  defs: string[];
  transition?: { name: string; from?: string; to?: string; sender?: string; guard?: string };
  exprPreview?: string;
  components: { id: string; name: string; file: string; symbols: string[] }[];
  tests: string[];
}

export interface StoryMeta {
  key: string;
  title: string;
  states: string[];
  transitions: string[];
  counts: { transitions: number; invariants: number; goals: number; steps: number; liveness: number };
  components: { id: string; name: string; file: string }[];
  tests: string[];
}

export interface SpecModelGraph {
  file: string;
  module: string;
  stateType?: string;
  stateFields: { name: string; type: string }[];
  roles: string[];
  projectionKind: "enum" | "projected" | "topology" | "library";
  projectionLabel: string;
  statusField?: string;
  initial?: Record<string, unknown>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  globalInvariants: { name: string; heading: string; expr: string; ruleKey: string }[];
  stepRules: { name: string; heading: string; ruleKey: string }[];
  goals: { name: string; heading: string; expr: string; ruleKey: string }[];
  stories: Record<string, StoryMeta>;
  rules: Record<string, RuleMeta>;
  components: { id: string; name: string; file: string }[];
  imports: string[];
}

export interface SimResult {
  available: boolean;
  module: string;
  state?: unknown;
  initial?: unknown;
  inv?: boolean;
  activeNode?: string;
  enabledEvents?: { name: string; allowed: boolean; sender?: string; sampleEvent?: Record<string, unknown> }[];
  error?: string;
}

interface ParsedDef {
  name: string;
  params: { name: string; type: string }[];
  returnType?: string;
  body: string;
  story: string;
  ruleKey: string;
  ruleHeading: string;
  quint: string;
}

interface ParsedVal {
  name: string;
  type?: string;
  body: string;
  story: string;
  ruleKey: string;
  ruleHeading: string;
}

interface ParsedType {
  name: string;
  body: string;
  ruleKey: string;
}

interface ParsedRuleBlock {
  story: string;
  storyKey: string;
  heading: string;
  key: string;
  quint: string;
  defs: string[];
}

interface ParsedSpecData {
  imports: string[];
  types: ParsedType[];
  enums: Map<string, string[]>;
  records: Map<string, { name: string; type: string }[]>;
  vals: ParsedVal[];
  defs: ParsedDef[];
  fairs: Map<string, string>;
  withins: Map<string, number>;
  ruleBlocks: ParsedRuleBlock[];
}

const LIFECYCLE_FIELDS = new Set(["status", "mode", "state", "phase", "stage", "job", "lifecycle"]);
const PRIMARY_BOOL_FIELDS = ["online", "connected", "active", "open", "enabled", "ready"];
const PRIMARY_LIST_FIELDS = ["pending", "queue", "queued", "items", "tasks", "messages", "net", "events"];

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const normSpec = (s: string) => s.replace(/^\.\//, "");

function safeModuleName(file: string): string {
  try {
    return specName(file);
  } catch {
    return path.posix.basename(file, ".md").replace(/[^A-Za-z0-9_]/g, "_") || "spec";
  }
}

function stripComments(text: string): string {
  let out = "";
  let mode: "" | '"' | "//" | "/*" = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === "" && ch === '"') { mode = '"'; out += ch; }
    else if (mode === "" && ch === "/" && text[i + 1] === "/") { mode = "//"; i++; }
    else if (mode === "" && ch === "/" && text[i + 1] === "*") { mode = "/*"; i++; }
    else if (mode === "") out += ch;
    else if (mode === '"') { out += ch; if (ch === '"') mode = ""; }
    else if (mode === "//" && ch === "\n") { mode = ""; out += "\n"; }
    else if (mode === "/*" && ch === "*" && text[i + 1] === "/") { mode = ""; i++; }
    else if (mode === "/*" && ch === "\n") out += "\n";
  }
  return out;
}

function scanTopLevel(text: string, onTop: (index: number) => boolean | void): void {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && onTop(i) === true) return;
  }
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let skipUntil = -1;
  scanTopLevel(text, (i) => {
    if (i < skipUntil || !text.startsWith(sep, i)) return;
    parts.push(text.slice(start, i).trim());
    skipUntil = i + sep.length;
    start = skipUntil;
  });
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function findMatching(text: string, openAt: number, open: string, close: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseParams(raw: string): { name: string; type: string }[] {
  if (!raw.trim()) return [];
  return splitTopLevel(raw, ",").flatMap((part) => {
    const at = part.indexOf(":");
    if (at < 0) return [];
    const name = part.slice(0, at).trim();
    const type = collapse(part.slice(at + 1));
    return name ? [{ name, type }] : [];
  });
}

function parseRecordFields(body: string): { name: string; type: string }[] | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const fields: { name: string; type: string }[] = [];
  for (const part of splitTopLevel(inner, ",")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const type = collapse(part.slice(at + 1));
    if (name && type) fields.push({ name, type });
  }
  return fields;
}

function parseEnumVariants(body: string): string[] | undefined {
  const parts = splitTopLevel(body, "|");
  if (parts.length < 2) return undefined;
  return parts.every((p) => /^[A-Z][A-Za-z0-9_]*$/.test(p)) ? parts : undefined;
}

function parseQuintValue(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) return text;
  if (text.startsWith("List(") && text.endsWith(")")) {
    const inner = text.slice(5, -1).trim();
    return inner ? splitTopLevel(inner, ",").map(parseQuintValue) : [];
  }
  if (text.startsWith("Set(") && text.endsWith(")")) {
    const inner = text.slice(4, -1).trim();
    return inner ? splitTopLevel(inner, ",").map(parseQuintValue) : [];
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevel(text.slice(1, -1), ",")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      const key = part.slice(0, at).trim();
      const val = part.slice(at + 1).trim();
      if (key) obj[key] = parseQuintValue(val);
    }
    return obj;
  }
  return text;
}

function splitDeclarations(code: string): string[] {
  const clean = stripComments(code);
  const lines = clean.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let depth = 0;
  let baseIndent: number | undefined;
  const startsDecl = /^\s*(?:import\s+|type\s+|const\s+|(?:pure\s+)?(?:def|val)\s+)/;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (depth === 0 && startsDecl.test(line) && (baseIndent === undefined || indent <= baseIndent)) {
      if (current.length) chunks.push(current.join("\n").trim());
      current = [line];
      baseIndent = indent;
    } else if (current.length || line.trim()) {
      current.push(line);
    }
    let inStr = false;
    for (const ch of line) {
      if (inStr) { if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  if (current.length) chunks.push(current.join("\n").trim());
  return chunks.filter(Boolean);
}

function parseDeclChunk(chunk: string, block: ParsedRuleBlock, out: ParsedSpecData) {
  const imp = chunk.match(/^import\s+([A-Za-z_]\w*)/);
  if (imp) {
    if (!out.imports.includes(imp[1])) out.imports.push(imp[1]);
    return;
  }
  const typeMatch = chunk.match(/^type\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
  if (typeMatch) {
    const [, name, body] = typeMatch;
    block.defs.push(name);
    out.types.push({ name, body: body.trim(), ruleKey: block.key });
    const variants = parseEnumVariants(body);
    if (variants) out.enums.set(name, variants);
    const fields = parseRecordFields(body);
    if (fields) out.records.set(name, fields);
    return;
  }
  const constMatch = chunk.match(/^const\s+([A-Za-z_]\w*)\s*:/);
  if (constMatch) {
    block.defs.push(constMatch[1]);
    return;
  }
  const valMatch = chunk.match(/^(?:pure\s+)?val\s+([A-Za-z_]\w*)(?:\s*:\s*([^=]+?))?\s*=\s*([\s\S]+)$/);
  if (valMatch) {
    const [, name, type, body] = valMatch;
    block.defs.push(name);
    out.vals.push({ name, type: type?.trim(), body: body.trim(), story: block.story, ruleKey: block.key, ruleHeading: block.heading });
    if (name.startsWith("fair_")) out.fairs.set(name.slice(5), body.trim().replace(/^"|"$/g, ""));
    if (name.startsWith("within_")) {
      const n = Number(body.trim());
      if (Number.isFinite(n)) out.withins.set(name.slice(7), n);
    }
    return;
  }
  const defHead = chunk.match(/^(?:pure\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
  if (!defHead) return;
  const openParen = chunk.indexOf("(", defHead.index);
  const closeParen = findMatching(chunk, openParen, "(", ")");
  if (closeParen < 0) return;
  const name = defHead[1];
  const params = parseParams(chunk.slice(openParen + 1, closeParen));
  const rest = chunk.slice(closeParen + 1);
  const eqAt = rest.indexOf("=");
  if (eqAt < 0) return;
  const retRaw = rest.slice(0, eqAt).trim();
  const returnType = retRaw.startsWith(":") ? collapse(retRaw.slice(1)) : undefined;
  const body = rest.slice(eqAt + 1).trim();
  block.defs.push(name);
  out.defs.push({ name, params, returnType, body, story: block.story, ruleKey: block.key, ruleHeading: block.heading, quint: chunk });
}

function parseSpecMarkdown(file: string, text: string): { outline: ReturnType<typeof outlineOf>; parsed: ParsedSpecData } {
  const outline = outlineOf(file, text);
  const parsed: ParsedSpecData = {
    imports: [], types: [], enums: new Map(), records: new Map(),
    vals: [], defs: [], fairs: new Map(), withins: new Map(), ruleBlocks: [],
  };
  for (const story of outline.stories) {
    const sTitle = story.title.trim();
    const sKey = storyKey(sTitle);
    for (const rule of story.rules) {
      const rHeading = rule.title.trim();
      const rKey = ruleKey(sTitle, rHeading);
      const quint = itemsOf(rule.body).filter((i) => i.quint).map((i) => i.text).join("\n\n");
      const block: ParsedRuleBlock = { story: sTitle, storyKey: sKey, heading: rHeading, key: rKey, quint, defs: [] };
      parsed.ruleBlocks.push(block);
      if (!quint) continue;
      for (const chunk of splitDeclarations(quint)) parseDeclChunk(chunk, block, parsed);
    }
  }
  return { outline, parsed };
}

function extractSender(guardBody: string | undefined, roles: string[]): string | undefined {
  if (!guardBody) return undefined;
  const eq = guardBody.match(/\bby\s*==\s*([A-Z][A-Za-z0-9_]*)\b/);
  if (eq && (!roles.length || roles.includes(eq[1]))) return eq[1];
  return undefined;
}

function extractFromStates(guardBody: string | undefined, stateParam: string, statusField: string, variants: string[]): string[] | undefined {
  if (!guardBody) return undefined;
  const escaped = `${stateParam}\\.${statusField}`;
  const eqMatches = [...guardBody.matchAll(new RegExp(`\\b${escaped}\\s*==\\s*([A-Z][A-Za-z0-9_]*)\\b`, "g"))]
    .map((m) => m[1]).filter((v) => variants.includes(v));
  const neqMatches = [...guardBody.matchAll(new RegExp(`\\b${escaped}\\s*!=\\s*([A-Z][A-Za-z0-9_]*)\\b`, "g"))]
    .map((m) => m[1]).filter((v) => variants.includes(v));
  if (eqMatches.length) {
    const isNegated = new RegExp(`not\\s*\\([^)]*\\b${escaped}\\s*==`).test(guardBody);
    if (!isNegated) return [...new Set(eqMatches)];
  }
  if (neqMatches.length) {
    const blocked = new Set(neqMatches);
    const allowed = variants.filter((v) => !blocked.has(v));
    if (allowed.length) return allowed;
  }
  return undefined;
}

function parseIfExpr(expr: string): { cond: string; thenBranch: string; elseBranch: string } | undefined {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("if")) return undefined;
  const open = trimmed.indexOf("(");
  if (open < 0) return undefined;
  const close = findMatching(trimmed, open, "(", ")");
  if (close < 0) return undefined;
  const cond = collapse(trimmed.slice(open + 1, close));
  const rest = trimmed.slice(close + 1).trim();
  let elseAt = -1;
  scanTopLevel(rest, (i) => {
    if (rest.startsWith("else", i) && (i === 0 || /\W/.test(rest[i - 1])) && (i + 4 >= rest.length || /\W/.test(rest[i + 4]))) {
      elseAt = i;
      return true;
    }
  });
  if (elseAt < 0) return undefined;
  return { cond, thenBranch: rest.slice(0, elseAt).trim(), elseBranch: rest.slice(elseAt + 4).trim() };
}

function extractFieldExpr(body: string, field: string): string | undefined {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    const close = findMatching(body, i, "{", "}");
    const inner = body.slice(i + 1, close > i ? close : body.length);
    for (const part of splitTopLevel(inner, ",")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      if (part.slice(0, at).trim() === field) return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

function extractTargetBranches(body: string, statusField: string, variants: string[], enumParam?: string): { to: string; condition?: string; isParam?: boolean }[] {
  const trimmed = body.trim();
  const topIf = parseIfExpr(trimmed);
  if (topIf) {
    const yes = extractTargetBranches(topIf.thenBranch, statusField, variants, enumParam)
      .map((b) => ({ ...b, condition: b.condition ? `${topIf.cond} and ${b.condition}` : topIf.cond }));
    const no = extractTargetBranches(topIf.elseBranch, statusField, variants, enumParam)
      .map((b) => ({ ...b, condition: b.condition ? `not(${topIf.cond}) and ${b.condition}` : `not(${topIf.cond})` }));
    return [...yes, ...no];
  }
  const value = extractFieldExpr(trimmed, statusField);
  if (!value) return [{ to: "__SELF__" }];
  const valIf = parseIfExpr(value);
  if (valIf) {
    const out: { to: string; condition?: string }[] = [];
    const t = valIf.thenBranch.trim();
    const e = valIf.elseBranch.trim();
    if (variants.includes(t)) out.push({ to: t, condition: valIf.cond });
    if (variants.includes(e)) out.push({ to: e, condition: `not(${valIf.cond})` });
    return out.length ? out : [{ to: "__SELF__" }];
  }
  const clean = value.trim();
  if (variants.includes(clean)) return [{ to: clean }];
  if (enumParam && clean === enumParam) return [{ to: "__PARAM__", isParam: true }];
  return [{ to: "__SELF__" }];
}

function extractScopedStates(expr: string, statusField: string, variants: string[]): string[] {
  const impliesAt = expr.indexOf("implies");
  if (impliesAt < 0) return [];
  const lhs = expr.slice(0, impliesAt);
  const found = [...lhs.matchAll(new RegExp(`\\.${statusField}\\s*==\\s*([A-Z][A-Za-z0-9_]*)\\b`, "g"))]
    .map((m) => m[1]).filter((v) => variants.includes(v));
  return [...new Set(found)];
}

interface ProjectionContext {
  parsed: ParsedSpecData;
  initialObj: Record<string, unknown> | undefined;
  transitions: ParsedDef[];
  guards: Map<string, ParsedDef>;
  roles: string[];
}

interface ProjectionOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  globalInvariants: SpecModelGraph["globalInvariants"];
  goals: SpecModelGraph["goals"];
  projectionLabel: string;
}

function collectGoals(
  defs: ParsedDef[],
  nodeMap?: Map<string, GraphNode>,
  targetOf?: (expr: string) => { id: string; exact: boolean } | undefined,
): SpecModelGraph["goals"] {
  const goals: SpecModelGraph["goals"] = [];
  for (const def of defs) {
    if (!/^sometimes[A-Z]/.test(def.name)) continue;
    const expr = collapse(def.body);
    goals.push({ name: def.name, heading: def.ruleHeading, expr, ruleKey: def.ruleKey });
    const hit = nodeMap && targetOf ? targetOf(expr) : undefined;
    if (hit && nodeMap?.has(hit.id) && (hit.exact || !nodeMap.get(hit.id)!.goal)) {
      nodeMap.get(hit.id)!.goal = def.ruleHeading;
    }
  }
  return goals;
}

function makeEdge(
  tr: ParsedDef,
  guardDef: ParsedDef | undefined,
  roles: string[],
  from: string,
  to: string,
  extra?: { idSuffix?: string; condition?: string; liveness?: GraphEdge["liveness"] },
): GraphEdge {
  const guardExpr = guardDef ? collapse(guardDef.body) : undefined;
  const sender = extractSender(guardExpr, roles);
  const params = tr.params.slice(1).filter((p) => p.name !== "by");
  const quint = guardDef ? `${guardDef.quint}\n${tr.quint}` : tr.quint;
  return {
    id: `${tr.name}:${from}->${to}${extra?.idSuffix ?? ""}`,
    name: tr.name,
    from,
    to,
    ...(guardDef ? { guard: guardDef.name, guardExpr } : {}),
    ...(extra?.condition ? { condition: extra.condition } : {}),
    ...(sender ? { sender } : {}),
    params,
    story: tr.story,
    ruleKey: tr.ruleKey,
    ruleHeading: tr.ruleHeading,
    quint,
    ...(extra?.liveness ? { liveness: extra.liveness } : {}),
    ...(from === to ? { selfLoop: true } : {}),
  };
}

function buildEnumProjection(
  ctx: ProjectionContext,
  stateType: string,
  statusField: string,
  statusEnumType: string,
  variants: string[],
): ProjectionOutput {
  const { parsed, initialObj, transitions, guards, roles } = ctx;
  const initialStatus = typeof initialObj?.[statusField] === "string" && variants.includes(initialObj[statusField])
    ? initialObj[statusField] : variants[0];
  const nodeMap = new Map<string, GraphNode>(variants.map((v) => [v, { id: v, label: v, ...(v === initialStatus ? { initial: true } : {}), invariants: [] }]));
  const globalInvariants: SpecModelGraph["globalInvariants"] = [];
  for (const def of parsed.defs) {
    if (!/^always[A-Z]/.test(def.name)) continue;
    const expr = collapse(def.body);
    const scoped = extractScopedStates(expr, statusField, variants);
    if (scoped.length) {
      for (const st of scoped) nodeMap.get(st)?.invariants.push(def.ruleHeading);
    } else {
      globalInvariants.push({ name: def.name, heading: def.ruleHeading, expr, ruleKey: def.ruleKey });
    }
  }
  const goals = collectGoals(parsed.defs, nodeMap, (expr) => {
    const pureMatch = expr.match(new RegExp(`^\\w+\\.${statusField}\\s*==\\s*([A-Z][A-Za-z0-9_]*)$`));
    if (pureMatch) return { id: pureMatch[1], exact: true };
    const anyMatch = expr.match(new RegExp(`\\b\\w+\\.${statusField}\\s*==\\s*([A-Z][A-Za-z0-9_]*)\\b`));
    return anyMatch ? { id: anyMatch[1], exact: false } : undefined;
  });

  const livenessByFrom = new Map<string, { rule: string; within?: number }>();
  for (const def of parsed.defs) {
    if (!/^leadsTo[A-Z]/.test(def.name)) continue;
    for (const st of extractScopedStates(collapse(def.body), statusField, variants)) {
      livenessByFrom.set(st, { rule: def.name, within: parsed.withins.get(def.name) });
    }
  }

  const edges: GraphEdge[] = [];
  for (const tr of transitions) {
    const guardDef = guards.get(tr.name);
    const guardExpr = guardDef ? collapse(guardDef.body) : undefined;
    const stateParam = tr.params[0]?.name ?? "s";
    const enumParam = tr.params.slice(1).find((p) => p.type === statusEnumType && p.name !== "by")?.name;
    const branches = extractTargetBranches(tr.body, statusField, variants, enumParam);
    const fromStates = extractFromStates(guardExpr, stateParam, statusField, variants)
      ?? extractFromStates(collapse(tr.body), stateParam, statusField, variants);

    if (branches.some((b) => b.isParam) && enumParam) {
      const forbid = guardExpr?.match(new RegExp(`not\\s*\\(\\s*${stateParam}\\.${statusField}\\s*==\\s*([A-Z]\\w*)\\s+and\\s+${enumParam}\\s*==\\s*([A-Z]\\w*)\\s*\\)`));
      const noSame = Boolean(guardExpr && new RegExp(`${stateParam}\\.${statusField}\\s*!=\\s*${enumParam}`).test(guardExpr));
      for (const from of fromStates ?? variants) {
        for (const to of variants) {
          if (noSame && from === to) continue;
          if (forbid && forbid[1] === from && forbid[2] === to) continue;
          edges.push(makeEdge(tr, guardDef, roles, from, to));
        }
      }
      continue;
    }

    const sources = fromStates ?? [initialStatus];
    for (const from of sources) {
      for (let bi = 0; bi < branches.length; bi++) {
        const branch = branches[bi];
        const to = branch.to === "__SELF__" ? from : branch.to;
        const fair = parsed.fairs.get(tr.name);
        const live = livenessByFrom.get(from);
        const liveness = live && from !== to && (fair || transitions.filter((u) => extractFromStates(guards.get(u.name)?.body, u.params[0]?.name ?? "s", statusField, variants)?.includes(from)).length === 1)
          ? { rule: live.rule, ...(live.within !== undefined ? { within: live.within } : {}), ...(fair ? { fair } : {}) }
          : undefined;
        edges.push(makeEdge(tr, guardDef, roles, from, to, {
          idSuffix: branches.length > 1 ? `#${bi}` : "",
          condition: branch.condition,
          liveness,
        }));
      }
    }
  }
  return {
    nodes: [...nodeMap.values()], edges, globalInvariants, goals,
    projectionLabel: `State enum: ${stateType}.${statusField} (${statusEnumType})`,
  };
}

interface ProjectedSpec {
  boolField: string;
  listField: string;
  ids: { tt: string; tf: string; ft: string; ff: string };
}

function projectedMeta(boolField: string, listField: string): { meta: ProjectedSpec; labels: Record<string, string> } {
  const isOnline = boolField === "online";
  const isQueue = ["pending", "queue", "queued"].includes(listField);
  const bTrue = isOnline ? "Online" : cap(boolField);
  const bFalse = isOnline ? "Offline" : `Not ${boolField}`;
  const lEmpty = isQueue ? "Synced" : `Empty ${listField}`;
  const lSome = isQueue ? "Queued" : `Has ${listField}`;
  const ids = isOnline && isQueue
    ? { tf: "online_synced", tt: "online_queued", ff: "offline_synced", ft: "offline_queued" }
    : { tf: `${boolField}_empty`, tt: `${boolField}_nonempty`, ff: `not_${boolField}_empty`, ft: `not_${boolField}_nonempty` };
  return {
    meta: { boolField, listField, ids },
    labels: {
      [ids.tf]: `${bTrue} · ${lEmpty}`,
      [ids.tt]: `${bTrue} · ${lSome}`,
      [ids.ff]: `${bFalse} · ${lEmpty}`,
      [ids.ft]: `${bFalse} · ${lSome}`,
    },
  };
}

function buildProjectedProjection(
  ctx: ProjectionContext,
  boolField: string,
  listField: string,
): ProjectionOutput {
  const { parsed, initialObj, transitions, guards, roles } = ctx;
  const { meta, labels } = projectedMeta(boolField, listField);
  const initBool = typeof initialObj?.[boolField] === "boolean" ? initialObj[boolField] : true;
  const initList = Array.isArray(initialObj?.[listField]) ? initialObj[listField].length > 0 : false;
  const initId = initBool ? (initList ? meta.ids.tt : meta.ids.tf) : (initList ? meta.ids.ft : meta.ids.ff);
  const predicates: Record<string, string> = {
    [meta.ids.tf]: `${boolField} && ${listField}.length == 0`,
    [meta.ids.tt]: `${boolField} && ${listField}.length > 0`,
    [meta.ids.ff]: `!${boolField} && ${listField}.length == 0`,
    [meta.ids.ft]: `!${boolField} && ${listField}.length > 0`,
  };
  const nodes: GraphNode[] = [meta.ids.tf, meta.ids.tt, meta.ids.ff, meta.ids.ft].map((id) => ({
    id, label: labels[id], ...(id === initId ? { initial: true } : {}), invariants: [], predicate: predicates[id],
  }));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const globalInvariants: SpecModelGraph["globalInvariants"] = parsed.defs
    .filter((d) => /^always[A-Z]/.test(d.name))
    .map((d) => ({ name: d.name, heading: d.ruleHeading, expr: collapse(d.body), ruleKey: d.ruleKey }));
  const goals = collectGoals(parsed.defs, nodeMap, (expr) => {
    const negBool = new RegExp(`not\\s*\\(\\s*\\w+\\.${boolField}\\s*\\)`).test(expr);
    const hasItems = new RegExp(`\\w+\\.${listField}\\.length\\(\\)\\s*(?:>|>=)\\s*[1-9]`).test(expr);
    const noItems = new RegExp(`\\w+\\.${listField}\\.length\\(\\)\\s*==\\s*0`).test(expr);
    const id = negBool ? (hasItems ? meta.ids.ft : meta.ids.ff) : noItems ? meta.ids.tf : hasItems ? meta.ids.tt : undefined;
    return id ? { id, exact: false } : undefined;
  });

  const edges: GraphEdge[] = [];
  const idFor = (b: boolean, nonEmpty: boolean) => (b ? (nonEmpty ? meta.ids.tt : meta.ids.tf) : (nonEmpty ? meta.ids.ft : meta.ids.ff));
  for (const tr of transitions) {
    const guardDef = guards.get(tr.name);
    const guardExpr = guardDef ? collapse(guardDef.body) : undefined;
    const stateParam = tr.params[0]?.name ?? "c";

    const reqFalse = Boolean(guardExpr && new RegExp(`(?:not\\s*\\(\\s*${stateParam}\\.${boolField}\\s*\\)|${stateParam}\\.${boolField}\\s*==\\s*false)`).test(guardExpr));
    const reqTrue = !reqFalse && Boolean(guardExpr && new RegExp(`\\b${stateParam}\\.${boolField}\\b`).test(guardExpr));
    const boolInputs = reqTrue ? [true] : reqFalse ? [false] : [true, false];

    const boolAssign = extractFieldExpr(tr.body, boolField);
    const nextBool = (b: boolean) => (boolAssign === "true" ? true : boolAssign === "false" ? false : b);

    const listAssign = extractFieldExpr(tr.body, listField) ?? "";
    const addsList = /\.(?:append|concat)\s*\(/.test(listAssign);
    const removesList = /\b(?:without|drop|tail|take)\s*\(|\.select\s*\(|^List\(\s*\)$/.test(listAssign);

    const pairs: [string, string][] = [];
    for (const b of boolInputs) {
      const nb = nextBool(b);
      if (addsList) {
        pairs.push([idFor(b, false), idFor(nb, true)]);
        if (!b) pairs.push([idFor(b, true), idFor(nb, true)]);
      } else if (removesList) {
        pairs.push([idFor(b, true), idFor(nb, false)]);
      } else if (nb !== b) {
        pairs.push([idFor(b, false), idFor(nb, false)], [idFor(b, true), idFor(nb, true)]);
      } else {
        pairs.push([idFor(b, false), idFor(nb, false)]);
      }
    }
    for (const [from, to] of pairs) edges.push(makeEdge(tr, guardDef, roles, from, to));
  }
  return {
    nodes, edges, globalInvariants, goals,
    projectionLabel: `Projected: ${boolField} × ${listField}.length > 0`,
  };
}

function chooseProjection(
  parsed: ParsedSpecData,
  stateType: string | undefined,
  stateFields: { name: string; type: string }[],
  guards: Map<string, ParsedDef>,
): { kind: "enum"; statusField: string; enumType: string; variants: string[] }
  | { kind: "projected"; boolField: string; listField: string }
  | { kind: "topology" }
  | { kind: "library" } {
  const hasInitial = parsed.vals.some((v) => v.name === "initial");
  if (!hasInitial) return { kind: "library" };
  const enumFields = stateFields.filter((f) => parsed.enums.has(f.type));
  const guardBodies = [...guards.values()].map((g) => g.body);
  const pickedEnum = enumFields.find((f) => LIFECYCLE_FIELDS.has(f.name))
    ?? enumFields.find((f) => guardBodies.some((b) => new RegExp(`\\.${f.name}\\b`).test(b)));
  if (pickedEnum) {
    return { kind: "enum", statusField: pickedEnum.name, enumType: pickedEnum.type, variants: parsed.enums.get(pickedEnum.type)! };
  }
  const boolFields = stateFields.filter((f) => f.type === "bool");
  const listFields = stateFields.filter((f) => /^(?:List|Set)\[/.test(f.type));
  if (boolFields.length && listFields.length) {
    const boolField = PRIMARY_BOOL_FIELDS.find((n) => boolFields.some((f) => f.name === n)) ?? boolFields[0].name;
    const listField = PRIMARY_LIST_FIELDS.find((n) => listFields.some((f) => f.name === n)) ?? listFields[0].name;
    return { kind: "projected", boolField, listField };
  }
  return stateType || hasInitial ? { kind: "topology" } : { kind: "library" };
}

function roleOfRule(block: ParsedRuleBlock, transitions: Set<string>, guards: Set<string>): RuleRole {
  if (block.defs.some((d) => transitions.has(d) || guards.has(d))) return "transition";
  if (block.defs.some((d) => /^always[A-Z]/.test(d))) return "always";
  if (block.defs.some((d) => /^step[A-Z]/.test(d))) return "step";
  if (block.defs.some((d) => /^sometimes[A-Z]/.test(d))) return "sometimes";
  if (block.defs.some((d) => /^leadsTo[A-Z]/.test(d))) return "leadsTo";
  if (block.defs.some((d) => /^law[A-Z]/.test(d))) return "law";
  if (block.defs.some((d) => /^refines[A-Z]/.test(d))) return "refines";
  if (block.story === "Domain" || block.defs.includes("initial") || /^type\s+/m.test(block.quint)) return "domain";
  return "helper";
}

function isTestPath(at: string): boolean {
  const file = at.replace(/:\d+$/, "");
  return /(?:^|\/)test\//.test(file) || /\.test\./.test(file);
}

function enrichMeta(
  file: string,
  outline: ReturnType<typeof outlineOf>,
  parsed: ParsedSpecData,
  edges: GraphEdge[],
  transitions: ParsedDef[],
  guards: Map<string, ParsedDef>,
  components?: ComponentIndex,
  allCitations?: Citation[],
): { stories: Record<string, StoryMeta>; rules: Record<string, RuleMeta>; specComponents: { id: string; name: string; file: string }[] } {
  const targetFile = normSpec(file);
  const allComponents = components?.components ?? [];
  const specCompsMap = new Map<string, { id: string; name: string; file: string }>();
  for (const c of allComponents) {
    const modelMatches = c.model && normSpec(c.model.spec) === targetFile;
    const citMatches = c.citations?.some((cit) => normSpec(cit.spec) === targetFile);
    if (modelMatches || citMatches) specCompsMap.set(c.id, { id: c.id, name: c.name, file: c.source.file });
  }

  const transSet = new Set(transitions.map((t) => t.name));
  const guardNameSet = new Set([...guards.values()].map((g) => g.name));
  const cits = (allCitations ?? []).filter((c) => normSpec(c.spec) === targetFile);
  const testFilesFor = (heading: string) => [...new Set(cits.filter((c) => c.heading === heading && isTestPath(c.at)).map((c) => c.at.replace(/:\d+$/, "")))];

  const rules: Record<string, RuleMeta> = {};
  for (const block of parsed.ruleBlocks) {
    const role = roleOfRule(block, transSet, guardNameSet);
    const ruleEdges = edges.filter((e) => e.ruleKey === block.key);
    const firstEdge = ruleEdges[0];
    const linkedComps: RuleMeta["components"] = [];
    for (const c of allComponents) {
      const sameSpec = (c.model && normSpec(c.model.spec) === targetFile) || c.citations?.some((cit) => normSpec(cit.spec) === targetFile);
      const citesRule = c.citations?.some((cit) => normSpec(cit.spec) === targetFile && cit.heading === block.heading);
      const symbols = sameSpec ? (c.uses ?? []).filter((sym) => block.defs.includes(sym)) : [];
      if (citesRule || symbols.length > 0) {
        linkedComps.push({ id: c.id, name: c.name, file: c.source.file, symbols });
      }
    }
    const firstLine = block.quint.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    rules[block.key] = {
      key: block.key,
      story: block.story,
      heading: block.heading,
      role,
      defs: block.defs,
      ...(firstEdge ? { transition: { name: firstEdge.name, from: firstEdge.from, to: firstEdge.to, sender: firstEdge.sender, guard: firstEdge.guard } } : {}),
      ...(firstLine ? { exprPreview: firstLine.slice(0, 120) } : {}),
      components: linkedComps,
      tests: testFilesFor(block.heading),
    };
  }

  const stories: Record<string, StoryMeta> = {};
  for (const story of outline.stories) {
    const title = story.title.trim();
    const sKey = storyKey(title);
    const storyBlocks = parsed.ruleBlocks.filter((b) => b.storyKey === sKey);
    const storyEdges = edges.filter((e) => e.story === title);
    const states = [...new Set(storyEdges.flatMap((e) => [e.from, e.to]))];
    const transNames = [...new Set(storyEdges.map((e) => e.name))];
    const allDefs = storyBlocks.flatMap((b) => b.defs);
    const compMap = new Map<string, { id: string; name: string; file: string }>();
    for (const b of storyBlocks) {
      for (const c of rules[b.key]?.components ?? []) compMap.set(c.id, { id: c.id, name: c.name, file: c.file });
    }
    for (const c of allComponents) {
      if (c.citations?.some((cit) => normSpec(cit.spec) === targetFile && cit.heading === title)) {
        compMap.set(c.id, { id: c.id, name: c.name, file: c.source.file });
      }
    }
    const tests = [...new Set([...testFilesFor(title), ...storyBlocks.flatMap((b) => rules[b.key]?.tests ?? [])])];
    stories[sKey] = {
      key: sKey,
      title,
      states,
      transitions: transNames,
      counts: {
        transitions: allDefs.filter((d) => transSet.has(d)).length,
        invariants: allDefs.filter((d) => /^always[A-Z]/.test(d)).length,
        goals: allDefs.filter((d) => /^sometimes[A-Z]/.test(d)).length,
        steps: allDefs.filter((d) => /^step[A-Z]/.test(d)).length,
        liveness: allDefs.filter((d) => /^leadsTo[A-Z]/.test(d)).length,
      },
      components: [...compMap.values()],
      tests,
    };
  }
  return { stories, rules, specComponents: [...specCompsMap.values()] };
}

/** Statically parse a spec's Markdown and Quint blocks into a SpecModelGraph without throwing on drafts. */
export function graphOfSpec(
  file: string,
  text: string,
  components?: ComponentIndex,
  allCitations?: Citation[],
): SpecModelGraph {
  const module = safeModuleName(file);
  const { outline, parsed } = parseSpecMarkdown(file, text);
  const initialVal = parsed.vals.find((v) => v.name === "initial");
  const initialParsed = initialVal ? parseQuintValue(initialVal.body) : undefined;
  const initialObj = initialParsed && typeof initialParsed === "object" && !Array.isArray(initialParsed)
    ? (initialParsed as Record<string, unknown>) : undefined;

  let stateType = initialVal?.type;
  if (!stateType && initialObj) {
    const initKeys = Object.keys(initialObj).sort().join(",");
    for (const [name, fields] of parsed.records) {
      if (fields.map((f) => f.name).sort().join(",") === initKeys) { stateType = name; break; }
    }
  }
  const stateFields = (stateType && parsed.records.get(stateType)) || [];
  const outputTypes = new Set<string>();
  if (stateType) {
    for (const [name, fields] of parsed.records) {
      if (fields.length === 2 && fields.some((f) => f.name === "state" && f.type === stateType) && fields.some((f) => f.name === "out")) {
        outputTypes.add(name);
      }
    }
  }

  const rulePrefix = /^(?:always|sometimes|step|leadsTo|law|refines|can)[A-Z]/;
  const transitions = !initialVal ? [] : parsed.defs.filter((d) => {
    if (rulePrefix.test(d.name) || d.params.length === 0) return false;
    const firstType = d.params[0].type;
    const ret = d.returnType;
    if (stateType) return firstType === stateType && (ret === stateType || (ret !== undefined && outputTypes.has(ret)));
    return d.body.includes(`...${d.params[0].name}`);
  });
  const guards = new Map<string, ParsedDef>();
  for (const tr of transitions) {
    const g = parsed.defs.find((d) => d.name === `can${cap(tr.name)}`);
    if (g) guards.set(tr.name, g);
  }
  const senderParam = transitions.flatMap((t) => t.params.filter((p) => p.name === "by"))[0];
  const roles = (senderParam && parsed.enums.get(senderParam.type)) ?? [];

  const stepRules: SpecModelGraph["stepRules"] = parsed.defs
    .filter((d) => /^step[A-Z]/.test(d.name))
    .map((d) => ({ name: d.name, heading: d.ruleHeading, ruleKey: d.ruleKey }));

  const proj = chooseProjection(parsed, stateType, stateFields, guards);
  const ctx: ProjectionContext = { parsed, initialObj, transitions, guards, roles };
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  let globalInvariants: SpecModelGraph["globalInvariants"];
  let goals: SpecModelGraph["goals"];
  let projectionLabel = "Library (no state machine)";
  let statusField: string | undefined;

  if (proj.kind === "enum") {
    statusField = proj.statusField;
    ({ nodes, edges, globalInvariants, goals, projectionLabel } = buildEnumProjection(
      ctx, stateType ?? "State", proj.statusField, proj.enumType, proj.variants,
    ));
  } else if (proj.kind === "projected") {
    ({ nodes, edges, globalInvariants, goals, projectionLabel } = buildProjectedProjection(
      ctx, proj.boolField, proj.listField,
    ));
  } else if (proj.kind === "topology") {
    const hubId = stateType ?? "State";
    projectionLabel = `Action topology: ${hubId}`;
    globalInvariants = parsed.defs.filter((d) => /^always[A-Z]/.test(d.name))
      .map((d) => ({ name: d.name, heading: d.ruleHeading, expr: collapse(d.body), ruleKey: d.ruleKey }));
    goals = collectGoals(parsed.defs);
    nodes = [{ id: hubId, label: hubId, initial: true, invariants: globalInvariants.map((i) => i.heading), predicate: stateFields.map((f) => f.name).join(", ") }];
    edges = transitions.map((tr) => makeEdge(tr, guards.get(tr.name), roles, hubId, hubId));
  } else {
    globalInvariants = parsed.defs.filter((d) => /^always[A-Z]/.test(d.name))
      .map((d) => ({ name: d.name, heading: d.ruleHeading, expr: collapse(d.body), ruleKey: d.ruleKey }));
    goals = collectGoals(parsed.defs);
  }

  const { stories, rules, specComponents } = enrichMeta(file, outline, parsed, edges, transitions, guards, components, allCitations);
  return {
    file, module, ...(stateType ? { stateType } : {}), stateFields, roles,
    projectionKind: proj.kind, projectionLabel, ...(statusField ? { statusField } : {}),
    ...(initialObj ? { initial: initialObj } : {}),
    nodes, edges, globalInvariants, stepRules, goals, stories, rules, components: specComponents, imports: parsed.imports,
  };
}

function locateGenModule(root: string, moduleName: string): string | undefined {
  if (!/^[A-Za-z0-9_]+$/.test(moduleName)) return undefined;
  const direct = path.join(root, "gen", `${moduleName}.ts`);
  if (fs.existsSync(direct)) return direct;
  for (const group of ["apps", "packages"]) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const candidate = path.join(dir, entry, "gen", `${moduleName}.ts`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function locateSpecForModule(root: string, moduleName: string): { file: string; text: string } | undefined {
  const rel = `spec/${moduleName.replaceAll("__", "/")}`;
  for (const candidate of [`${rel}.md`, `${rel}/index.md`]) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full)) return { file: candidate, text: fs.readFileSync(full, "utf8") };
  }
  return undefined;
}

function resolveActiveNode(graph: SpecModelGraph | undefined, state: unknown): string | undefined {
  if (!graph || !state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const rec = state as Record<string, unknown>;
  if (graph.projectionKind === "enum" && graph.statusField) {
    const v = rec[graph.statusField];
    return typeof v === "string" ? v : undefined;
  }
  if (graph.projectionKind === "projected") {
    const boolField = PRIMARY_BOOL_FIELDS.find((n) => typeof rec[n] === "boolean")
      ?? graph.stateFields.find((f) => f.type === "bool")?.name;
    const listField = PRIMARY_LIST_FIELDS.find((n) => Array.isArray(rec[n]))
      ?? graph.stateFields.find((f) => /^(?:List|Set)\[/.test(f.type))?.name;
    if (boolField && listField) {
      const { meta } = projectedMeta(boolField, listField);
      const b = Boolean(rec[boolField]);
      const nonEmpty = Array.isArray(rec[listField]) && (rec[listField] as unknown[]).length > 0;
      return b ? (nonEmpty ? meta.ids.tt : meta.ids.tf) : (nonEmpty ? meta.ids.ft : meta.ids.ff);
    }
  }
  if (graph.projectionKind === "topology") return graph.nodes[0]?.id;
  return undefined;
}

function sampleParamValue(param: { name: string; type: string }, state: unknown, transName: string): unknown {
  const rec = state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  if (param.type === "int") {
    if (param.name === "amount") {
      const due = typeof rec.due === "number" ? rec.due : 0;
      const paid = typeof rec.paid === "number" ? rec.paid : 0;
      if (transName === "takeBack") return paid > 0 ? paid : 1;
      return due - paid > 0 ? due - paid : 5;
    }
    if (param.name === "seq") {
      const pending = Array.isArray(rec.pending) ? (rec.pending as { seq?: number }[]) : [];
      return pending[0]?.seq ?? 1;
    }
    if (param.name === "version") return typeof rec.seen === "number" ? rec.seen + 1 : 1;
    return 1;
  }
  if (param.type === "bool") return true;
  if (param.type === "str") return "Ada";
  if (/^(?:List|Set)\[/.test(param.type)) return [];
  if (param.type === "Op") {
    const made = typeof rec.made === "number" ? rec.made : 0;
    return { tag: "Create", id: `sim-${made + 1}`, title: "Sample item" };
  }
  return "";
}

/** Dynamically load `gen/<moduleName>.ts` in Node 26 and run initial/step/inv/enabled. */
export async function simulateModule(
  root: string,
  moduleName: string,
  body: { state?: unknown; event?: unknown; by?: unknown },
): Promise<SimResult> {
  const genFile = locateGenModule(root, moduleName);
  if (!genFile) return { available: false, module: moduleName };
  try {
    const stat = fs.statSync(genFile);
    const mod = await import(`${pathToFileURL(genFile).href}?t=${stat.mtimeMs}`) as Record<string, unknown>;
    if (mod.initial === undefined || typeof mod.step !== "function" || typeof mod.enabled !== "function") {
      return { available: false, module: moduleName, error: "module has no state machine" };
    }
    const specDoc = locateSpecForModule(root, moduleName);
    const graph = specDoc ? graphOfSpec(specDoc.file, specDoc.text) : undefined;
    const stepFn = mod.step as (s: unknown, e: unknown, by?: unknown) => unknown;
    const enabledFn = mod.enabled as (s: unknown, e: unknown, by?: unknown) => boolean;
    const invFn = typeof mod.inv === "function" ? (mod.inv as (s: unknown) => boolean) : undefined;
    const hasSender = typeof mod.parseSender === "function";

    let state: unknown = body.state !== undefined ? body.state : mod.initial;
    if (body.event !== undefined) {
      const by = body.by ?? (hasSender ? graph?.roles[0] : undefined);
      const next = hasSender ? stepFn(state, body.event, by) : stepFn(state, body.event);
      state = next && typeof next === "object" && !Array.isArray(next) && "state" in next && "out" in next
        ? (next as { state: unknown }).state : next;
    }

    const inv = invFn ? Boolean(invFn(state)) : undefined;
    const activeNode = resolveActiveNode(graph, state);
    const uniqueEdges = new Map<string, GraphEdge>();
    for (const edge of graph?.edges ?? []) if (!uniqueEdges.has(edge.name)) uniqueEdges.set(edge.name, edge);

    const enabledEvents: NonNullable<SimResult["enabledEvents"]> = [];
    for (const edge of uniqueEdges.values()) {
      const sampleEvent: Record<string, unknown> = { type: edge.name };
      for (const p of edge.params) sampleEvent[p.name] = sampleParamValue(p, state, edge.name);
      const senderCandidates = hasSender
        ? [...new Set([body.by, edge.sender, ...(graph?.roles ?? [])].filter((v): v is string => typeof v === "string"))]
        : [undefined];
      let allowed = false;
      let chosenSender: string | undefined = edge.sender ?? (typeof body.by === "string" ? body.by : undefined);
      for (const candidate of senderCandidates) {
        try {
          if (hasSender ? enabledFn(state, sampleEvent, candidate) : enabledFn(state, sampleEvent)) {
            allowed = true;
            chosenSender = candidate;
            break;
          }
        } catch {
          // Sample parameter shape did not match a custom type; try remaining candidates.
        }
      }
      if (!allowed && graph?.projectionKind === "enum" && edge.params.length === 1) {
        for (const node of graph.nodes) {
          const alt = { ...sampleEvent, [edge.params[0].name]: node.id };
          try {
            if (hasSender ? enabledFn(state, alt, chosenSender) : enabledFn(state, alt)) {
              allowed = true;
              sampleEvent[edge.params[0].name] = node.id;
              break;
            }
          } catch {
            // Try next enum variant.
          }
        }
      }
      enabledEvents.push({ name: edge.name, allowed, ...(chosenSender ? { sender: chosenSender } : {}), sampleEvent });
    }
    return { available: true, module: moduleName, state, initial: mod.initial, inv, activeNode, enabledEvents };
  } catch (e) {
    return { available: false, module: moduleName, error: (e as Error).message };
  }
}
