import { createRequire } from "node:module";
import { QuintLexer } from "@informalsystems/quint/dist/src/generated/QuintLexer.js";
import { AnnotatedOperDefContext, DeprecatedOperDefContext, OperContext, QuintParser } from "@informalsystems/quint/dist/src/generated/QuintParser.js";

type Tokens = ConstructorParameters<typeof QuintParser>[0] & {
  fill(): void;
  getTokens(): ReturnType<QuintLexer["nextToken"]>[];
};

interface ParserRuntime {
  CharStreams: { fromString(text: string): ConstructorParameters<typeof QuintLexer>[0] };
  CommonTokenStream: new (lexer: QuintLexer) => Tokens;
}

interface Span {
  begin: number;
  end: number;
  firstToken: number;
  lastToken: number;
}

export function ordinarySource({ source, module, guides }: { source: string; module: string; guides: readonly string[] }): string | undefined {
  const wanted = new Set(guides);
  if (!wanted.size || wanted.size !== guides.length || guides.some((name) => !/^\w+$/.test(name))) return;
  const quintRequire = createRequire(import.meta.resolve("@informalsystems/quint/package.json"));
  const { CharStreams, CommonTokenStream }: ParserRuntime = quintRequire("antlr4ts");
  let recovered = false;
  const errors = { syntaxError() { recovered = true; } };
  const lexer = new QuintLexer(CharStreams.fromString(source));
  lexer.removeErrorListeners();
  lexer.addErrorListener(errors);
  const tokens = new CommonTokenStream(lexer);
  const parser = new QuintParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(errors);
  const modules = parser.modules().module();
  tokens.fill();
  const own = modules[0];
  if (recovered || modules.length !== 1 || !own || own.qualId().text !== module) return;

  let offset = 0;
  const utf16 = [offset];
  for (const character of source) utf16.push(offset += character.length);
  const spans: Span[] = [];
  const found = new Set<string>();
  for (const documented of own.documentedDeclaration()) {
    const declaration = documented.declaration();
    if (!(declaration instanceof OperContext)) continue;
    const op = declaration.operDef();
    if (!(op instanceof AnnotatedOperDefContext || op instanceof DeprecatedOperDefContext)) continue;
    const name = op.normalCallName().text;
    if (!wanted.has(name)) continue;
    if (documented.DOCCOMMENT().length || found.has(name) || op.qualifier().text !== "pureval" || !op.expr() || !op.stop) return;
    const begin = utf16[declaration.start.startIndex];
    const end = utf16[op.stop.stopIndex + 1];
    if (begin === undefined || end === undefined || end <= begin || (spans.at(-1)?.end ?? 0) > begin) return;
    found.add(name);
    spans.push({ begin, end, firstToken: declaration.start.tokenIndex, lastToken: op.stop.tokenIndex });
  }
  if (found.size !== wanted.size) return;

  const mentionsGuide = new RegExp(`\\b(?:${guides.join("|")})\\b`);
  const ignored = new Set([QuintLexer.STRING, QuintLexer.DOCCOMMENT, QuintLexer.LINE_COMMENT, QuintLexer.COMMENT]);
  for (const token of tokens.getTokens()) {
    if (ignored.has(token.type) || !token.text || !mentionsGuide.test(token.text)) continue;
    if (!spans.some(({ firstToken, lastToken }) => token.tokenIndex >= firstToken && token.tokenIndex <= lastToken)) return;
  }

  let cursor = 0;
  let projected = "";
  for (const { begin, end } of spans) {
    projected += source.slice(cursor, begin) + source.slice(begin, end).replace(/[^\n\r]/g, " ");
    cursor = end;
  }
  return projected + source.slice(cursor);
}
