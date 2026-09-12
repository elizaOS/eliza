/**
 * Finds and rewrites only syntax-owned ECMAScript module specifiers while preserving all other source bytes.
 * Build callers provide the path-resolution policy because source and emitted trees resolve extensions differently.
 */
import ts from "typescript";

/** @param {import("typescript").Node} node */
function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isExternalModuleReference(node) &&
    node.expression &&
    ts.isStringLiteralLike(node.expression)
  ) {
    return node.expression;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  return null;
}

/** @param {string} value @param {string} quote */
function encodeStringContent(value, quote) {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\v", "\\v")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll(quote, `\\${quote}`);
  return quote === "`" ? escaped.replaceAll("${", "\\${") : escaped;
}

/**
 * @param {string} source
 * @param {string} filePath
 * @param {(specifier: string) => string | Promise<string>} resolveSpecifier
 */
export async function rewriteModuleSpecifiers(
  source,
  filePath,
  resolveSpecifier,
) {
  const scriptKind = /\.tsx?$/.test(filePath)
    ? filePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const ranges = [];
  const visit = (node) => {
    const literal = moduleSpecifier(node);
    if (literal) {
      ranges.push({
        start: literal.getStart(sourceFile) + 1,
        end: literal.getEnd() - 1,
        quote: source[literal.getStart(sourceFile)],
        value: literal.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let output = source;
  let changed = false;
  for (const range of ranges.reverse()) {
    const replacement = await resolveSpecifier(range.value);
    if (replacement !== range.value) {
      const encoded = encodeStringContent(replacement, range.quote);
      output = `${output.slice(0, range.start)}${encoded}${output.slice(range.end)}`;
      changed = true;
    }
  }
  return { changed, source: output };
}
