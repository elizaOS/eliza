import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

export const SIMULATOR = import.meta.filename;
export const TABLE = "table.json";
export const compiledAs = (name: string) => `${name}.expr.json`;

async function compile(input: string, main: string) {
  const { load, parse, typecheck } = await import("@informalsystems/quint/dist/src/cliCommands.js");
  const { toExpr } = await import("@informalsystems/quint/dist/src/cliHelpers.js");
  const { bigintCheckerReplacer } = await import("@informalsystems/quint/dist/src/rust/helpers.js");
  const { stringify }: { stringify(value: unknown, replacer: typeof bigintCheckerReplacer): string } = createRequire(import.meta.resolve("@informalsystems/quint/package.json"))("json-bigint");
  const typed = (await typecheck((await parse((await load({ input, main })).unwrap())).unwrap())).unwrap();
  const names = typed.modules.find((m) => m.name === main)?.declarations.flatMap((d) => (d.kind === "def" && (d.qualifier === "val" || d.qualifier === "action") ? [d.name] : [])) ?? [];
  for (const name of names) fs.writeFileSync(compiledAs(name), stringify(toExpr(typed, name).unwrap(), bigintCheckerReplacer));
  fs.writeFileSync(TABLE, stringify(typed.resolver.table, bigintCheckerReplacer));
}

async function run(input: string, o: { main: string; step: string; invariant: string; samples: number; steps: number; traces: number; threads: number; seed: bigint; mbt: boolean; itf: string }) {
  const { CommandWrapper } = await import("@informalsystems/quint/dist/src/rust/commandWrapper.js");
  const { prepareOnTrace } = await import("@informalsystems/quint/dist/src/cliReporting.js");
  const { parseJsonBig } = await import("@informalsystems/quint/dist/src/jsonHelper.js");
  const read = (file: string) => parseJsonBig(fs.readFileSync(file, "utf8"));
  const parsed = { modules: [], table: read(TABLE), main: o.main, init: read(compiledAs("init")), step: read(compiledAs(o.step)), invariants: [read(compiledAs(o.invariant))], witnesses: [] };
  const { status } = await new CommandWrapper(2).simulate(parsed, path.resolve(input), o.samples, o.steps, o.traces, Math.min(o.samples, o.threads), o.seed, o.mbt, prepareOnTrace(input, o.itf, o.traces, o.mbt));
  if (status === "violation") console.error("error: Invariant violated");
  process.exitCode = status === "ok" ? 0 : status === "violation" ? 1 : 2;
}

if (import.meta.main) {
  const text = { type: "string", default: "" } as const;
  const { positionals: [command, input], values } = parseArgs({ allowPositionals: true, options: { main: text, step: text, invariant: text, "max-samples": text, "max-steps": text, "n-traces": text, "n-threads": text, seed: text, mbt: { type: "boolean", default: false }, "out-itf": text } });
  if (command === "compile") await compile(input, values.main);
  else await run(input, { main: values.main, step: values.step, invariant: values.invariant, samples: Number(values["max-samples"]), steps: Number(values["max-steps"]), traces: Number(values["n-traces"]), threads: Number(values["n-threads"]), seed: BigInt(values.seed), mbt: values.mbt, itf: values["out-itf"] });
}
