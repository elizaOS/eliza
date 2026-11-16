// The Effect face of a generated module, in VibeLang: gen/<name>.effect.vibe beside gen/<name>.ts. It is read off the
// generated TypeScript itself, so it cannot say anything that module does not.
import ts from "typescript";
import { HELPERS } from "./typescript.ts";
import { fail } from "./types.ts";

/** Helpers the generated module exports for its own use (typescript.ts), and the proof obligation of `initial`. */
const INTERNAL = new RegExp(`^(?:${HELPERS.join("|")})_|^initialHolds$`);
/** The adapter's typed failures. */
const FAILURES = ["Rejected", "NotAnEvent", "NotAState", "NotASender"];
/** What the adapter itself exports for a state machine; a spec that binds one of these cannot have an adapter. */
const OWN = [...FAILURES, "Machine", "machine", "machineOver", "stored", "apply", "decodeEvent", "decodeState", "decodeSender"];

/**
 * `text` is gen/<name>.ts. Every constant and function comes back under its own name from a TypeScript `module` body,
 * the one place a `.vibe` file states what a function throws: effect code may then call them bare. They throw nothing
 * the program should handle: the one exception generated code raises, a RangeError past 2^53, is a defect.
 * A state machine also gets typed failures for what `parseEvent`, `parseState` and `enabled` refuse, and a `Machine`
 * service that applies one event at a time to the state where it is kept: in memory (`machine`), in a store
 * (`stored`) or wherever the shell loads and keeps it (`machineOver`).
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
    ...(step ? [`  /** A Machine never shares a state with its callers. @throws {never} */`,
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
    `import * as KeyValueStore from "effect/persistence/KeyValueStore"`,
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
    `  /** The state the Machine was made with, or the last one an event sent to it led to; then each one an event sent to it leads to. */`,
    `  readonly changes: Stream.Stream<${state}>`,
    `  /** The state as it is kept now. */`,
    `  get(): ${state}!!`,
    `  /** An event already parsed; a value from outside goes through \`receive\`. */`,
    `  send(event: T.Event${by}): ${stepped}!Rejected`,
    `  receive(input: unknown${by}): ${stepped}!(NotAnEvent | Rejected)`,
    `}`,
    ``,
    `/**`,
    ` * A Machine over a state kept elsewhere: \`load\` reads it and \`keep\` writes it. Each event is applied to what \`load\``,
    ` * reads when it is sent, so that a state another writer kept since is stepped from, never written over, and the state`,
    ` * it leads to goes to \`keep\` before \`send\` returns. It fails as the first \`load\` does; where a later \`load\` fails`,
    ` * or \`keep\` dies, \`send\` dies and the state stays as it was. It never shares a state with its callers.`,
    ` */`,
    `export effect function machineOver<E>(load: () => ${state}!E, keep: (next: ${state}) => void!!): Machine.Shape!E {`,
    `  const shown = try SubscriptionRef.make(${snapshot}(try load()))`,
    `  effect function send(event: T.Event${by}): ${stepped}!Rejected {`,
    `    const input = ${snapshot}({ event${passed} })`,
    `    uninterruptible {`,
    `      return try SubscriptionRef.modifyEffect(shown, effect () => {`,
    `        const next = try apply(${snapshot}(try orDie(load())), input.event${sender ? ", input.by" : ""})`,
    `        try keep(${snapshot}(${emits ? "next.state" : "next"}))`,
    `        return [${snapshot}(next), ${emits ? "next.state" : "next"}] as const`,
    `      })`,
    `    }`,
    `  }`,
    `  return {`,
    `    changes: Stream.map(SubscriptionRef.changes(shown), ${snapshot}),`,
    `    effect get() { return ${snapshot}(try orDie(load())) },`,
    `    send,`,
    `    effect receive(input: unknown${by}) { return try send(try decodeEvent(input)${passed}) }`,
    `  }`,
    `}`,
    ``,
    `/** A Machine in memory, from \`initial\` or a state \`decodeState\` returned. */`,
    `export function machine(start: ${state} = initial) {`,
    `  return Layer.effect(Machine, effect {`,
    `    const kept = try Ref.make(${snapshot}(start))`,
    `    return try machineOver(() => Ref.get(kept), (next) => Ref.set(kept, next))`,
    `  })`,
    `}`,
    ``,
    `/**`,
    ` * A Machine kept in the KeyValueStore under \`key\`, as JSON: each event is applied to what is stored there when it`,
    ` * is sent, read through \`decodeState\`, or to \`start\` where nothing is, so that a state another page or program`,
    ` * stored since is stepped from, never written over. What is stored and is not a state fails the layer with NotAState,`,
    ` * and a later \`send\` dies on it, so that it is never written over either. Each state an event leads to is stored`,
    ` * before \`send\` returns: where the store does not take it, \`send\` dies and the state stays as it was.`,
    ` */`,
    `export function stored(key: string, start: ${state} = initial) {`,
    `  return Layer.effect(Machine, effect {`,
    `    const store = try KeyValueStore.KeyValueStore`,
    `    effect function load() {`,
    `      const found = try store.get(key)`,
    `      return found === undefined ? start`,
    `        : try decodeState(try Effect.try({ try: () => JSON.parse(found) as unknown, catch: () => new NotAState({ input: found }) }))`,
    `    }`,
    `    return try machineOver(load, (next) => orDie(store.set(key, JSON.stringify(next))))`,
    `  })`,
    `}`,
    ``,
  ].join("\n");
}
