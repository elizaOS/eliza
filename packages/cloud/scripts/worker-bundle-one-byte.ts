/**
 * Keeps the built Cloud API Worker bundle in V8's one-byte string form.
 *
 * V8 keeps a module's whole source text alive for lazy function compilation.
 * One UTF-16 code unit above U+00FF anywhere in the ~32 MB bundle makes V8
 * store that text at two bytes per character. In workerd the isolate then
 * retains 80.0 MB after startup instead of 48.6 MB, and 118.7 MB instead of
 * 87.3 MB once a voice route has loaded, against the 128 MB per-isolate limit
 * past which Cloudflare starts a fresh isolate for later requests.
 *
 * Each such code unit is rewritten only where the program stays the same, and
 * every other site is refused, so the bundle check fails instead of shipping a
 * different program:
 *   - string literals and untagged templates: `\uXXXX` gives the same value
 *     (an untagged template's raw text cannot be observed);
 *   - regular-expression literals: `/p/f` becomes `new R("p","f")`. The
 *     string's value is exactly the literal's pattern text, and `R` is the
 *     RegExp intrinsic, read by a statement placed before any bundle code
 *     runs. The new object therefore has the same pattern text: matching,
 *     `source`, `flags` and `toString()` do not change. Escaping inside the
 *     literal would change `source`;
 *   - comments: U+2028 and U+2029 become "\n", so the comment still contains
 *     a line terminator for automatic semicolon insertion; other code units
 *     become `\uXXXX` text. Legal comments (`/*!`, `//!`, `@license`,
 *     `@preserve`) and `sourceMappingURL`/`sourceURL` comments are refused;
 *   - U+2028 and U+2029 between tokens become "\n".
 * Tagged templates are refused, `String.raw` included. The tag receives the
 * raw text, and no static check can show that the tag at run time is the
 * untouched `String.raw`: a binding named String, an assignment or an accessor
 * can replace it. Identifiers and unclassified sites are refused too. Write
 * those characters as escapes in the source instead.
 *
 * Not preserved: Function.prototype.toString of a function or class that
 * contains a rewritten site, and columns after a rewrite on the same line
 * (Error.stack positions and source maps). With --write the adjacent source
 * map's columns are updated.
 *
 * Usage: node packages/cloud/scripts/worker-bundle-one-byte.ts <bundle.js> [--write]
 * Without --write it only verifies that the bundle can be made one-byte.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type TemplateTag = "none" | "String.raw" | "other";
export type Edit = { start: number; end: number; text: string };
export type Refusal = { offset: number; site: string };

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const REGEXP_ALIAS = "__oneByteRegExp";

export class OneByteRefusal extends Error {
  readonly refusals: readonly Refusal[];

  constructor(source: string, refusals: readonly Refusal[]) {
    super(
      `${refusals.length} character(s) above U+00FF cannot be rewritten safely:\n${refusals
        .map((refusal) => describeRefusal(source, refusal))
        .join("\n")}`,
    );
    this.refusals = refusals;
  }
}

function describeRefusal(source: string, { offset, site }: Refusal): string {
  const context = source.slice(Math.max(0, offset - 40), offset + 20);
  return `  offset ${offset} (${site}): ${JSON.stringify(context)}`;
}

function escapeCodeUnit(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

function isLineTerminator(code: number): boolean {
  return code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

function hasOddBackslashRunBefore(source: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && source.charCodeAt(i) === 0x5c; i--) {
    count++;
  }
  return count % 2 === 1;
}

function firstIndexAtOrAfter(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "worker-bundle.js",
    source,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    },
    false,
    ts.ScriptKind.JS,
  );
}

/** parseDiagnostics is not in the public typings. */
function firstParseDiagnostic(file: ts.SourceFile): ts.Diagnostic | undefined {
  return (file as unknown as { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics[0];
}

function templateTagOf(tag: ts.Expression): TemplateTag {
  return ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === "String" &&
    tag.name.text === "raw"
    ? "String.raw"
    : "other";
}

function commentSite(comment: string): string {
  if (/^\/[/*][#@]\s*source(?:MappingURL|URL)=/.test(comment)) {
    return "source-map-comment";
  }
  if (/^\/[/*]!|@license|@preserve/.test(comment)) return "legal-comment";
  return "comment";
}

function declaresName(parent: ts.Node, node: ts.Identifier): boolean {
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  );
}

function isModule(file: ts.SourceFile): boolean {
  return file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )),
  );
}

/**
 * A name, unused in the bundle, for the RegExp intrinsic captured by the
 * bundle's first statement, or the reason it cannot be captured. In an ES
 * module with no binding named RegExp, that statement reads the global before
 * any bundle code can replace it.
 */
function regExpAliasOrReason(
  source: string,
  file: ts.SourceFile,
): { alias: string } | { reason: string } {
  if (!isModule(file)) return { reason: "bundle is not an ES module" };
  if (source.startsWith("#!")) return { reason: "bundle starts with #!" };
  const taken = new Set<string>();
  let binding: number | undefined;
  const stack: Array<[ts.Node, ts.Node]> = [];
  ts.forEachChild(file, (child) => {
    stack.push([child, file]);
  });
  while (stack.length > 0) {
    const [node, parent] = stack.pop() as [ts.Node, ts.Node];
    if (ts.isIdentifier(node)) {
      if (node.text === "RegExp" && declaresName(parent, node)) {
        binding ??= node.getStart(file);
      }
      if (node.text.startsWith(REGEXP_ALIAS)) taken.add(node.text);
    }
    ts.forEachChild(node, (child) => {
      stack.push([child, node]);
    });
  }
  if (binding !== undefined) {
    return {
      reason: `a binding named RegExp is declared at offset ${binding}`,
    };
  }
  let alias = REGEXP_ALIAS;
  for (let n = 1; taken.has(alias) || source.includes(alias); n++) {
    alias = `${REGEXP_ALIAS}${n}`;
  }
  return { alias };
}

/** `/p/f` as `new R("p","f")`: the string's value is the pattern text. */
function regExpConstruction(
  literal: string,
  alias: string,
  before: string,
): string {
  const close = literal.lastIndexOf("/");
  let pattern = "";
  for (let i = 1; i < close; i++) {
    const code = literal.charCodeAt(i);
    pattern +=
      code === 0x5c
        ? "\\\\"
        : code === 0x22
          ? '\\"'
          : code > 0xff
            ? escapeCodeUnit(code)
            : literal[i];
  }
  // A space keeps `return/p/` from becoming `returnnew`.
  const space = /[\w$\x80-\xff]/.test(before) ? " " : "";
  return `${space}new ${alias}("${pattern}","${literal.slice(close + 1)}")`;
}

export type OneByteAnalysis = {
  /** Code units above U+00FF by the kind of site that holds them. */
  sites: Record<string, number>;
  regExpLiterals: number;
  edits: Edit[];
  refusals: Refusal[];
};

/** Classifies every code unit above U+00FF and plans its rewrite. */
export function analyzeOneByte(source: string): OneByteAnalysis {
  const positions: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) > 0xff) positions.push(i);
  }
  const analysis: OneByteAnalysis = {
    sites: {},
    regExpLiterals: 0,
    edits: [],
    refusals: [],
  };
  if (positions.length === 0) return analysis;

  const file = parse(source);
  const diagnostic = firstParseDiagnostic(file);
  if (diagnostic !== undefined) {
    // A tree recovered from a syntax error could misplace literal boundaries.
    analysis.refusals.push({
      offset: diagnostic.start ?? 0,
      site: "parse-error",
    });
    return analysis;
  }

  const unitSites = new Map<number, string>();
  const regExps: Array<[number, number]> = [];
  const visit = (node: ts.Node, tag: TemplateTag): void => {
    const first = firstIndexAtOrAfter(positions, node.pos);
    if (first >= positions.length || positions[first] >= node.end) return;
    const children = node.getChildren(file);
    if (children.length > 0) {
      for (const child of children) {
        let childTag: TemplateTag = "none";
        if (ts.isTaggedTemplateExpression(node)) {
          childTag = child === node.template ? templateTagOf(node.tag) : "none";
        } else if (
          ts.isTemplateExpression(node) ||
          node.kind === ts.SyntaxKind.SyntaxList ||
          (ts.isTemplateSpan(node) && child === node.literal)
        ) {
          childTag = tag;
        }
        visit(child, childTag);
      }
      return;
    }
    // A token: its leading trivia (whitespace and comments) runs from pos.
    const start = node.getStart(file);
    const comments = [
      ...(ts.getTrailingCommentRanges(source, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
    ];
    for (let i = first; i < positions.length && positions[i] < start; i++) {
      const index = positions[i];
      const comment = comments.find((r) => r.pos <= index && index < r.end);
      const lineTerminator = isLineTerminator(source.charCodeAt(index));
      unitSites.set(
        index,
        comment === undefined
          ? lineTerminator
            ? "line-terminator"
            : "whitespace"
          : commentSite(source.slice(comment.pos, comment.end)) +
              (lineTerminator ? "-line-terminator" : ""),
      );
    }
    let site: string;
    switch (node.kind) {
      case ts.SyntaxKind.RegularExpressionLiteral:
        regExps.push([start, node.end]);
        site = "regexp";
        break;
      case ts.SyntaxKind.StringLiteral:
        site = "string";
        break;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        site = tag === "none" ? "template" : `tagged-template:${tag}`;
        break;
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.PrivateIdentifier:
        site = "identifier";
        break;
      default:
        site = `token:${ts.SyntaxKind[node.kind]}`;
    }
    for (
      let i = firstIndexAtOrAfter(positions, start);
      i < positions.length && positions[i] < node.end;
      i++
    ) {
      unitSites.set(positions[i], site);
    }
  };
  visit(file, "none");

  const alias =
    regExps.length > 0 ? regExpAliasOrReason(source, file) : undefined;
  if (alias !== undefined && "alias" in alias) {
    analysis.edits.push({
      start: 0,
      end: 0,
      text: `var ${alias.alias}=RegExp;`,
    });
    for (const [start, end] of regExps) {
      analysis.edits.push({
        start,
        end,
        text: regExpConstruction(
          source.slice(start, end),
          alias.alias,
          source.charAt(start - 1),
        ),
      });
    }
    analysis.regExpLiterals = regExps.length;
  }

  for (const index of positions) {
    let site = unitSites.get(index) ?? "unclassified";
    const code = source.charCodeAt(index);
    let edit: Edit | null = null;
    let rewritten = false;
    switch (site) {
      case "regexp":
        // The whole literal is one edit, planned above.
        if (alias !== undefined && "reason" in alias) {
          site = `regexp:${alias.reason}`;
        } else {
          rewritten = true;
        }
        break;
      case "comment":
        edit = { start: index, end: index + 1, text: escapeCodeUnit(code) };
        break;
      case "comment-line-terminator":
      case "line-terminator":
        // "\r" then U+2028 is two line breaks; "\r\n" would be one.
        if (source.charCodeAt(index - 1) === 0x0d) {
          site = `${site}:after-carriage-return`;
        } else {
          edit = { start: index, end: index + 1, text: "\n" };
        }
        break;
      case "string":
      case "template":
        if (!hasOddBackslashRunBefore(source, index)) {
          edit = { start: index, end: index + 1, text: escapeCodeUnit(code) };
        } else if (isLineTerminator(code)) {
          // A backslash before a line terminator is a line continuation.
          edit = { start: index, end: index + 1, text: "\n" };
        } else {
          // `\X` is an identity escape: replace the backslash with it.
          edit = {
            start: index - 1,
            end: index + 1,
            text: escapeCodeUnit(code),
          };
        }
        break;
    }
    if (edit !== null) {
      analysis.edits.push(edit);
      rewritten = true;
    } else if (!rewritten) {
      analysis.refusals.push({ offset: index, site });
    }
    const key = rewritten ? site : `refused:${site}`;
    analysis.sites[key] = (analysis.sites[key] ?? 0) + 1;
  }
  analysis.edits.sort((a, b) => a.start - b.start || a.end - b.end);
  return analysis;
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  const parts: string[] = [];
  let copiedTo = 0;
  for (const edit of edits) {
    if (edit.start < copiedTo) throw new Error("overlapping one-byte edits");
    parts.push(source.slice(copiedTo, edit.start), edit.text);
    copiedTo = edit.end;
  }
  parts.push(source.slice(copiedTo));
  return parts.join("");
}

/** Returns the bundle with every code unit above U+00FF rewritten, or throws. */
export function toOneByteBundle(source: string): {
  source: string;
  escaped: number;
  edits: Edit[];
  analysis: OneByteAnalysis;
} {
  const analysis = analyzeOneByte(source);
  if (analysis.refusals.length > 0) {
    throw new OneByteRefusal(source, analysis.refusals);
  }
  if (analysis.edits.length === 0) {
    return { source, escaped: 0, edits: [], analysis };
  }
  const output = applyEdits(source, analysis.edits);
  for (let i = 0; i < output.length; i++) {
    if (output.charCodeAt(i) > 0xff) {
      throw new OneByteRefusal(output, [{ offset: i, site: "output" }]);
    }
  }
  const diagnostic = firstParseDiagnostic(parse(output));
  if (diagnostic !== undefined) {
    throw new OneByteRefusal(output, [
      { offset: diagnostic.start ?? 0, site: "output-parse-error" },
    ]);
  }
  const escaped = Object.values(analysis.sites).reduce((a, b) => a + b, 0);
  return { source: output, escaped, edits: analysis.edits, analysis };
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) {
  BASE64_VALUES[BASE64.charCodeAt(i)] = i;
}

function decodeVlq(text: string, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let digit: number;
  do {
    digit = BASE64_VALUES[text.charCodeAt(at++)] ?? -1;
    if (digit < 0) throw new Error(`invalid source map mappings at ${at - 1}`);
    value += (digit & 31) * 2 ** shift;
    shift += 5;
  } while (digit & 32);
  return [value % 2 === 1 ? -(value - 1) / 2 : value / 2, at];
}

function encodeVlq(value: number): string {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let text = "";
  do {
    const digit = rest % 32;
    rest = Math.floor(rest / 32);
    text += BASE64[rest > 0 ? digit | 32 : digit];
  } while (rest > 0);
  return text;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

/**
 * Moves the generated columns of source map `mappings` so that every segment
 * keeps pointing at the same code after `edits` are applied to `source`.
 */
export function shiftSourceMapColumns(
  mappings: string,
  source: string,
  edits: readonly Edit[],
): string {
  // Generators disagree on whether "\r", U+2028 and U+2029 start a line.
  const lineBreak = source.search(/[\r\u2028\u2029]/);
  if (lineBreak >= 0) {
    throw new OneByteRefusal(source, [
      { offset: lineBreak, site: "source-map-line-break" },
    ]);
  }
  const starts = lineStartsOf(source);
  const shifts = new Map<number, Array<[number, number]>>();
  for (const edit of edits) {
    const line = firstIndexAtOrAfter(starts, edit.start + 1) - 1;
    if (edit.end > (starts[line + 1] ?? source.length + 1) - 1) {
      throw new Error("a one-byte edit spans lines");
    }
    const lineShifts = shifts.get(line) ?? [];
    lineShifts.push([
      edit.end - starts[line],
      edit.text.length - (edit.end - edit.start),
    ]);
    shifts.set(line, lineShifts);
  }
  const lines = mappings.split(";");
  for (const [line, lineShifts] of shifts) {
    if (line >= lines.length) continue;
    let column = 0;
    let shifted = 0;
    let delta = 0;
    let next = 0;
    lines[line] = lines[line]
      .split(",")
      .map((segment) => {
        if (segment === "") return segment;
        const [step, rest] = decodeVlq(segment, 0);
        if (step < 0) throw new Error("unsorted source map segments");
        column += step;
        while (next < lineShifts.length && lineShifts[next][0] <= column) {
          delta += lineShifts[next++][1];
        }
        const text = encodeVlq(column + delta - shifted) + segment.slice(rest);
        shifted = column + delta;
        return text;
      })
      .join(",");
  }
  return lines.join(";");
}

/** Original `source:line` for each offset, from the bundle's source map. */
function originalLocations(
  map: { mappings: string; sources: string[] },
  source: string,
  offsets: readonly number[],
): Map<number, string> {
  const starts = lineStartsOf(source);
  const wanted = new Map<number, number[]>();
  for (const offset of offsets) {
    const line = firstIndexAtOrAfter(starts, offset + 1) - 1;
    wanted.set(line, [...(wanted.get(line) ?? []), offset]);
  }
  const found = new Map<number, string>();
  const state = [0, 0, 0];
  map.mappings.split(";").forEach((segments, line) => {
    let column = 0;
    const targets = wanted.get(line) ?? [];
    for (const segment of segments.split(",")) {
      if (segment === "") continue;
      let at = 0;
      const fields: number[] = [];
      while (at < segment.length) {
        const [value, next] = decodeVlq(segment, at);
        fields.push(value);
        at = next;
      }
      column += fields[0];
      if (fields.length < 4) continue;
      for (let f = 1; f < 4; f++) state[f - 1] += fields[f];
      // Segments are sorted, so the last one at or before an offset wins.
      for (const offset of targets) {
        if (column <= offset - starts[line]) {
          found.set(offset, `${map.sources[state[0]]}:${state[1] + 1}`);
        }
      }
    }
  });
  return found;
}

function sourceMapPath(bundle: string, source: string): string | null {
  const match = /\/\/# sourceMappingURL=([^\s'"]+)\s*$/.exec(
    source.slice(-1024),
  );
  if (!match || /^[a-z]+:/i.test(match[1])) return null;
  const path = resolve(dirname(bundle), match[1]);
  return existsSync(path) ? path : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const bundle = args.find((arg) => !arg.startsWith("--"));
  if (!bundle) {
    console.error(
      "usage: node worker-bundle-one-byte.ts <bundle.js> [--write]",
    );
    process.exitCode = 2;
    return;
  }
  const input = readFileSync(bundle, "utf8");
  const mapPath = sourceMapPath(bundle, input);
  try {
    const result = toOneByteBundle(input);
    let mapWritten = false;
    if (write && result.edits.length > 0) {
      // Compute the map before writing anything, so a refusal writes nothing.
      const map =
        mapPath === null
          ? null
          : (JSON.parse(readFileSync(mapPath, "utf8")) as {
              mappings: string;
              sections?: unknown;
            });
      if (map?.sections !== undefined) {
        throw new Error("indexed source maps are not supported");
      }
      if (map !== null) {
        map.mappings = shiftSourceMapColumns(map.mappings, input, result.edits);
      }
      writeFileSync(bundle, result.source);
      if (mapPath !== null && map !== null) {
        writeFileSync(mapPath, JSON.stringify(map));
        mapWritten = true;
      }
    }
    console.log(
      JSON.stringify({
        bundle,
        sites: result.analysis.sites,
        regExpLiterals: result.analysis.regExpLiterals,
        written: write && result.edits.length > 0,
        sourceMapWritten: mapWritten,
        characters: result.source.length,
      }),
    );
  } catch (error) {
    if (!(error instanceof OneByteRefusal)) throw error;
    const locations =
      mapPath === null
        ? new Map<number, string>()
        : originalLocations(
            JSON.parse(readFileSync(mapPath, "utf8")),
            input,
            error.refusals.map((refusal) => refusal.offset),
          );
    const lines = error.refusals.map(
      (refusal) =>
        `${describeRefusal(input, refusal)}${
          locations.has(refusal.offset)
            ? ` from ${locations.get(refusal.offset)}`
            : ""
        }`,
    );
    console.error(
      `::error::Worker bundle is not one-byte safe. ${error.refusals.length} character(s) above U+00FF cannot be rewritten safely; write them as escapes in the source:\n${lines.join("\n")}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
