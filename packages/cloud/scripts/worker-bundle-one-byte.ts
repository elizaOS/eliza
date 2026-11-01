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
 * esbuild already escapes string literals, so such characters survive only in
 * regular-expression literals and tagged templates. This pass rewrites a code
 * unit only where the rewrite is exactly equivalent, and refuses every other
 * site so a new one fails the bundle check instead of silently doubling memory:
 *   - regular-expression and string literals: `\uXXXX` (a surrogate pair
 *     becomes two escapes, which `u`/`v` patterns read as one code point);
 *   - untagged template text: `\uXXXX` (only the cooked value is observable);
 *   - `String.raw` template text: `${"\uXXXX"}`, which yields the same string;
 *   - comments: `\uXXXX` (no runtime meaning).
 * Identifiers and text of other tagged templates (for example drizzle `sql`)
 * are refused; write those characters as escapes in the source instead.
 *
 * Usage: node packages/cloud/scripts/worker-bundle-one-byte.ts <bundle.js> [--write]
 * Without --write it only verifies that the bundle can be made one-byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type Site = "literal" | "template" | "raw-template" | "comment";
type TemplateTag = "none" | "string-raw" | "other";

export class OneByteRefusal extends Error {
  constructor(sites: readonly string[]) {
    super(
      `${sites.length} character(s) above U+00FF cannot be escaped safely:\n${sites.join("\n")}`,
    );
  }
}

function escapeCodeUnit(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
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

function isStringRawTag(tag: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === "String" &&
    tag.name.text === "raw"
  );
}

function parseOrRefuse(source: string): ts.SourceFile {
  const file = ts.createSourceFile(
    "worker-bundle.js",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  // parseDiagnostics is not in the public typings; a tree recovered from a
  // syntax error could misplace literal boundaries, so refuse it.
  const { parseDiagnostics } = file as unknown as {
    parseDiagnostics: readonly ts.Diagnostic[];
  };
  if (parseDiagnostics.length > 0) {
    throw new OneByteRefusal([
      `bundle has ${parseDiagnostics.length} parse diagnostic(s); first at ${parseDiagnostics[0].start}`,
    ]);
  }
  return file;
}

/** Maps each wide code unit position to the literal kind that contains it. */
function classifyWidePositions(
  source: string,
  positions: readonly number[],
): Map<number, Site> {
  const file = parseOrRefuse(source);
  const sites = new Map<number, Site>();
  const stack: Array<[ts.Node, TemplateTag]> = [[file, "none"]];
  while (stack.length > 0) {
    const [node, tag] = stack.pop() as [ts.Node, TemplateTag];
    const first = firstIndexAtOrAfter(positions, node.pos);
    if (first >= positions.length || positions[first] >= node.end) continue;
    let site: Site | null = null;
    switch (node.kind) {
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.StringLiteral:
        site = "literal";
        break;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        site =
          tag === "none"
            ? "template"
            : tag === "string-raw"
              ? "raw-template"
              : null;
        break;
    }
    if (site !== null) {
      const start = node.getStart(file);
      for (
        let i = first;
        i < positions.length && positions[i] < node.end;
        i++
      ) {
        if (positions[i] >= start) sites.set(positions[i], site);
      }
      continue;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      stack.push([node.tag, "none"]);
      stack.push([
        node.template,
        isStringRawTag(node.tag) ? "string-raw" : "other",
      ]);
      continue;
    }
    if (ts.isTemplateExpression(node)) {
      stack.push([node.head, tag]);
      for (const span of node.templateSpans) {
        stack.push([span.expression, "none"]);
        stack.push([span.literal, tag]);
      }
      continue;
    }
    ts.forEachChild(node, (child) => {
      // Comments live in the leading trivia of the next node (legal comments
      // end the bundle, before the end-of-file token).
      const first = firstIndexAtOrAfter(positions, child.pos);
      if (first < positions.length && positions[first] < child.end) {
        for (const range of [
          // Comments before the first line break count as trailing ones.
          ...(ts.getTrailingCommentRanges(source, child.pos) ?? []),
          ...(ts.getLeadingCommentRanges(source, child.pos) ?? []),
        ]) {
          for (
            let i = firstIndexAtOrAfter(positions, range.pos);
            i < positions.length && positions[i] < range.end;
            i++
          ) {
            sites.set(positions[i], "comment");
          }
        }
      }
      stack.push([child, "none"]);
    });
  }
  return sites;
}

function describeSite(source: string, index: number): string {
  const context = source.slice(Math.max(0, index - 40), index + 20);
  return `  offset ${index}: ${JSON.stringify(context)}`;
}

/** Returns the bundle with every code unit above U+00FF escaped, or throws. */
export function toOneByteBundle(source: string): {
  source: string;
  escaped: number;
} {
  const positions: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) > 0xff) positions.push(i);
  }
  if (positions.length === 0) return { source, escaped: 0 };

  const sites = classifyWidePositions(source, positions);
  const refused: string[] = [];
  const parts: string[] = [];
  let copiedTo = 0;
  for (const index of positions) {
    const site = sites.get(index);
    const code = source.charCodeAt(index);
    // In a literal, `\X` for a non-syntax character X is an identity escape,
    // so the escaping backslash is replaced together with the character;
    // `\` before U+2028/U+2029 is a line continuation instead.
    const identityEscape =
      site === "literal" && hasOddBackslashRunBefore(source, index);
    if (
      site === undefined ||
      (identityEscape && (code === 0x2028 || code === 0x2029)) ||
      (site !== "literal" &&
        site !== "comment" &&
        hasOddBackslashRunBefore(source, index))
    ) {
      refused.push(describeSite(source, index));
      continue;
    }
    parts.push(source.slice(copiedTo, identityEscape ? index - 1 : index));
    const escaped = escapeCodeUnit(code);
    parts.push(site === "raw-template" ? `\${"${escaped}"}` : escaped);
    copiedTo = index + 1;
  }
  if (refused.length > 0) throw new OneByteRefusal(refused);
  parts.push(source.slice(copiedTo));
  const output = parts.join("");
  for (let i = 0; i < output.length; i++) {
    if (output.charCodeAt(i) > 0xff) {
      throw new OneByteRefusal([describeSite(output, i)]);
    }
  }
  parseOrRefuse(output);
  return { source: output, escaped: positions.length };
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error(
      "usage: node worker-bundle-one-byte.ts <bundle.js> [--write]",
    );
    process.exitCode = 2;
    return;
  }
  const input = readFileSync(file, "utf8");
  try {
    const result = toOneByteBundle(input);
    if (write && result.escaped > 0) writeFileSync(file, result.source);
    console.log(
      JSON.stringify({
        bundle: file,
        escaped: result.escaped,
        written: write && result.escaped > 0,
        characters: result.source.length,
      }),
    );
  } catch (error) {
    if (!(error instanceof OneByteRefusal)) throw error;
    console.error(
      `::error::Worker bundle is not one-byte safe. ${error.message}`,
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
