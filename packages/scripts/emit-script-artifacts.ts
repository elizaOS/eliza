/** Emits Node-compatible JavaScript siblings for packaged TypeScript script sources. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function emitScriptArtifacts(directory: string): string[] {
  const sources = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => path.resolve(directory, name));
  const sourceSet = new Set(sources);
  const names = new Map<string, string[]>();
  for (const source of sources) {
    const name = path.basename(source);
    names.set(name, [...(names.get(name) ?? []), source]);
  }
  const emitted: string[] = [];
  for (const source of sources) {
    const rewritePath = (value: string): string =>
      value.replace(/[A-Za-z0-9_@.$/{}-]+\.ts\b/g, (token) => {
        const local = path.resolve(path.dirname(source), token);
        const candidates = names.get(path.basename(token));
        return sourceSet.has(local) || candidates?.length === 1
          ? `${token.slice(0, -3)}.mjs`
          : token;
      });
    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isStringLiteral(node)) {
          const text = rewritePath(node.text);
          if (text !== node.text) return ts.factory.createStringLiteral(text);
        }
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
          const text = rewritePath(node.text);
          if (text !== node.text)
            return ts.factory.createNoSubstitutionTemplateLiteral(text);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitEachChild(node, visit, context);
    };
    const result = ts.transpileModule(readFileSync(source, "utf8"), {
      fileName: source,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
      transformers: { before: [transformer] },
      reportDiagnostics: true,
    });
    const errors = result.diagnostics?.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors?.length) {
      throw new Error(
        `Cannot emit ${source}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`,
      );
    }
    const destination = `${source.slice(0, -3)}.mjs`;
    writeFileSync(destination, result.outputText);
    emitted.push(destination);
  }
  return emitted;
}
