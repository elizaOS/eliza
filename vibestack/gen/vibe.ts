// The Effect face of a generated module, in VibeLang: gen/<name>.effect.vibe beside gen/<name>.ts. It is read off the
// generated TypeScript itself, so it cannot say anything that module does not.
import ts from "typescript";
import { fail } from "./types.ts";

/** Helpers the generated module exports for its own use (typescript.ts), and the proof obligation of `initial`. */
const INTERNAL = /^(?:exact|equal|quotient|remainder|lookup\d+)_|^initialHolds$/;
/** The adapter's typed failures. */
const FAILURES = ["Rejected", "NotAnEvent", "NotAState", "NotASender"];
/** What the adapter itself exports for a state machine; a spec that binds one of these cannot have an adapter. */
const OWN = [...FAILURES, "Machine", "machine", "apply", "decodeEvent", "decodeState", "decodeSender"];

/**
 * `text` is gen/<name>.ts. Every constant and function comes back under its own name from a TypeScript `module` body,
 * the one place a `.vibe` file states what a function throws: effect code may then call them bare. They throw nothing
 * the program should handle: the one exception generated code raises, a RangeError past 2^53, is a defect.
 * A state machine also gets typed failures for what `parseEvent`, `parseState` and `enabled` refuse, and a `Machine`
 * service that holds the state and applies one event at a time.
 */
export function effectAdapter(name: string, source: string, text: string, namespace: string): string {
  const file = ts.createSourceFile(`${name}.ts`, text, ts.ScriptTarget.Latest, true);
  const exported = (s: ts.Statement) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const types = file.statements.filter((s): s is ts.TypeAliasDeclaration | ts.InterfaceDeclaration => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && exported(s)).map((s) => s.name.text);
  // A type of another module is spelled <module>_<name> in signatures, as the generated module imports it.
  const foreign = file.statements.filter(ts.isImportDeclaration).flatMap((s) => {
    const names = s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) ? s.importClause.namedBindings.elements.filter((e) => e.isTypeOnly) : [];
    return names.length ? [`  import type { ${names.map((e) => `${e.propertyName!.text} as ${e.name.text}`).join(", ")} } from ${s.moduleSpecifier.getText(file)}`] : [];
  });
  const doc = (s: ts.Node) => {
    const said = ts.getJSDocCommentsAndTags(s).filter(ts.isJSDoc).map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join(" ").replace(/\s+/g, " ").trim();
    return `  /** ${said ? `${said} ` : ""}@throws {never} */`;
  };
  const consts = file.statements.filter((s): s is ts.VariableStatement => ts.isVariableStatement(s) && exported(s)).flatMap((s) =>
    s.declarationList.declarations.map((d) => ({ name: d.name.getText(file), line: `${doc(s)}\n  export const ${d.name.getText(file)}: ${d.type!.getText(file)} = M.${d.name.getText(file)}` })));
  const funs = file.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && exported(s) && !INTERNAL.test(s.name!.text));
  const wrapper = (f: ts.FunctionDeclaration) => {
    const params = f.parameters.map((p) => p.getText(file)).join(", ");
    return `${doc(f)}\n  export function ${f.name!.text}(${params}): ${f.type!.getText(file)} { return M.${f.name!.text}(${f.parameters.map((p) => p.name.getText(file)).join(", ")}) }`;
  };
  const names = [...consts.map((c) => c.name), ...funs.map((f) => f.name!.text)];
  const snapshot = `snapshot_${name}`;
  const step = funs.find((f) => f.name!.text === "step");
  const body = names.length ? [
    `module pure {`,
    `  import * as M from "./${name}.ts"`,
    ...(types.length ? [`  import type { ${types.join(", ")} } from "./${name}.ts"`] : []),
    ...foreign,
    ...consts.map((c) => c.line),
    ...funs.map(wrapper),
    ...(step ? [`  /** A Machine never shares its held state with callers. @throws {never} */`,
      `  export function ${snapshot}<A>(value: A): A { return structuredClone(value) }`] : []),
    `}`,
    `import { ${[...names, ...step ? [snapshot] : []].join(", ")} } from pure`,
    `export { ${names.join(", ")} }`,
  ] : [];
  const out = [
    `// GENERATED from ${source} by vibestack/spec.ts. Do not edit: change the spec and run \`pnpm gen\`.`,
    `// gen/${name}.ts for Effect code: its definitions as functions that throw nothing${step ? ", and its state machine as typed failures and a service" : ""}.`,
    `export type * from "./${name}.ts"`,
    ``,
    ...body,
  ];
  if (!step) return [...out, ``].join("\n");

  const clash = OWN.find((n) => names.includes(n) || types.includes(n));
  if (clash) fail(`${source}: \`${clash}\` is a name of the generated Effect adapter (gen/${name}.effect.vibe); name the definition otherwise`);
  // A type the module exports is named through it; any other is read off `step`, so that no name of the spec is bound here.
  const typed = (node: ts.TypeNode, otherwise: string) => (types.includes(node.getText(file)) ? `T.${node.getText(file)}` : otherwise);
  const state = typed(step.parameters[0].type!, "Parameters<typeof step>[0]");
  const stepped = typed(step.type!, "ReturnType<typeof step>");
  const sender = step.parameters[2] && typed(step.parameters[2].type!, "Parameters<typeof step>[2]");
  const emits = step.type!.getText(file) !== step.parameters[0].type!.getText(file);
  const by = sender ? `, by: ${sender}` : "";
  const passed = sender ? ", by" : "";
  return [
    ...out,
    `import type * as T from "./${name}.ts"`,
    ``,
    `/** The rules do not allow this event in this state${sender ? " from this sender" : ""}. */`,
    `export error Rejected { event: T.Event; state: ${state}${sender ? `; by: ${sender}` : ""} }`,
    `/** An untrusted value that is not an event. */`,
    `export error NotAnEvent { input: unknown }`,
    `/** An untrusted value that is not a state satisfying every \`always\` rule. */`,
    `export error NotAState { input: unknown }`,
    ...(sender ? [`/** An untrusted value that is not a sender. */`, `export error NotASender { input: unknown }`] : []),
    ``,
    `/** \`parseEvent\`, failing where it returns undefined. */`,
    `export effect function decodeEvent(input: unknown): T.Event!NotAnEvent {`,
    `  const event = parseEvent(input)`,
    `  if (event === undefined) throw new NotAnEvent({ input })`,
    `  return event`,
    `}`,
    ``,
    `/** \`parseState\`, failing where it returns undefined. */`,
    `export effect function decodeState(input: unknown): ${state}!NotAState {`,
    `  const parsed = parseState(input)`,
    `  if (parsed === undefined) throw new NotAState({ input })`,
    `  return parsed`,
    `}`,
    ...(sender ? [
      ``,
      `/** \`parseSender\`, failing where it returns undefined. */`,
      `export effect function decodeSender(input: unknown): ${sender}!NotASender {`,
      `  const parsed = parseSender(input)`,
      `  if (parsed === undefined) throw new NotASender({ input })`,
      `  return parsed`,
      `}`,
    ] : []),
    ``,
    `/** \`step\`, failing where \`enabled\` refuses the event instead of leaving the state unchanged. */`,
    `export effect function apply(current: ${state}, event: T.Event${by}): ${stepped}!Rejected {`,
    `  if (!enabled(current, event${passed})) throw new Rejected({ event, state: current${passed} })`,
    `  return step(current, event${passed})`,
    `}`,
    ``,
    `/** The state, and the one way to change it: an event the rules allow, applied before the next is looked at. */`,
    `export service Machine {`,
    // VibeLang derives a key from the nearest package.json's name, and gen/package.json has none (genDir in units.ts).
    // The package and the spec together name a machine: two packages may each have spec/index.md.
    `  static readonly key = ${JSON.stringify(`${namespace}/${source}#Machine`)}`,
    `  /** The current state, then every later one. */`,
    `  readonly changes: Stream.Stream<${state}>`,
    `  get(): ${state}!!`,
    `  /** An event already parsed; a value from outside goes through \`receive\`. */`,
    `  send(event: T.Event${by}): ${stepped}!Rejected`,
    `  receive(input: unknown${by}): ${stepped}!(NotAnEvent | Rejected)`,
    `}`,
    ``,
    `/** A Machine in memory, from \`initial\` or a state \`decodeState\` returned. */`,
    `export function machine(start: ${state} = initial) {`,
    `  return Layer.effect(Machine, effect {`,
    `    const held = try SubscriptionRef.make(${snapshot}(start))`,
    `    effect function send(event: T.Event${by}): ${stepped}!Rejected {`,
    `      const input = ${snapshot}({ event${passed} })`,
    `      return try SubscriptionRef.modifyEffect(held, effect (current) => {`,
    `        const next = try apply(${snapshot}(current), input.event${sender ? ", input.by" : ""})`,
    `        return [${snapshot}(next), ${emits ? "next.state" : "next"}] as const`,
    `      })`,
    `    }`,
    `    return {`,
    `      changes: Stream.map(SubscriptionRef.changes(held), ${snapshot}),`,
    `      effect get() { return ${snapshot}(try SubscriptionRef.get(held)) },`,
    `      send,`,
    `      effect receive(input: unknown${by}) { return try send(try decodeEvent(input)${passed}) }`,
    `    }`,
    `  })`,
    `}`,
    ``,
  ].join("\n");
}
