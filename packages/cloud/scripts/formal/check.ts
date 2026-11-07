import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const formal = path.join(root, "packages/cloud/formal");
const require = createRequire(import.meta.url);
const exhaustive = process.argv.includes("--verify");
const symbolic = process.argv.includes("--bounded");
const verifying = exhaustive || symbolic;
const selected = process.argv
  .find((arg) => arg.startsWith("--model="))
  ?.slice(8);
const version = "0.33.1";
const manifest = JSON.parse(
  readFileSync(path.join(formal, "contracts.json"), "utf8"),
) as {
  models: Array<{
    id: string;
    file: string;
    sources: string[];
    invariants: string[];
    assumptions: string[];
    maxSteps: number;
  }>;
};
const files = readdirSync(path.join(formal, "models")).filter((name) =>
  name.endsWith(".qnt"),
);
const ids = new Set<string>();
for (const model of manifest.models) {
  if (ids.has(model.id)) throw new Error(`Duplicate model: ${model.id}`);
  ids.add(model.id);
  if (!files.includes(model.file))
    throw new Error(`Missing model: ${model.file}`);
  if (
    !model.invariants.length ||
    !model.assumptions.length ||
    !model.sources.length
  ) {
    throw new Error(`Incomplete contract: ${model.id}`);
  }
  for (const source of model.sources) readFileSync(path.join(root, source));
}
for (const file of files) {
  if (!manifest.models.some((model) => model.file === file)) {
    throw new Error(`Unregistered model: ${file}`);
  }
}
const registeredFiles = new Set(manifest.models.map((model) => model.file));
for (const file of readdirSync(path.join(formal, "inventory")).filter((name) =>
  name.endsWith(".json"),
)) {
  const inventory = JSON.parse(
    readFileSync(path.join(formal, "inventory", file), "utf8"),
  ) as {
    flows: Array<{
      id: string;
      sources: string[];
      models: string[];
      coverage: string;
    }>;
  };
  for (const flow of inventory.flows) {
    for (const model of flow.models) {
      if (!registeredFiles.has(model))
        throw new Error(`Unregistered inventory model: ${flow.id}: ${model}`);
    }
    for (const source of flow.sources) {
      if (!existsSync(path.join(root, source)))
        throw new Error(`Missing inventory source: ${flow.id}: ${source}`);
    }
    if (flow.coverage === "partial-bounded-model" && flow.models.length === 0) {
      throw new Error(
        `Inventory claims model coverage without a model: ${flow.id}`,
      );
    }
  }
}
if (selected && !ids.has(selected))
  throw new Error(`Unknown model: ${selected}`);
const modelsToRun = manifest.models.filter(
  (model) => !selected || model.id === selected,
);
if (modelsToRun.length === 0) throw new Error("No cloud models selected");
const quintPackage = require.resolve("@informalsystems/quint/package.json");
const installed = JSON.parse(readFileSync(quintPackage, "utf8")) as {
  version: string;
};
if (installed.version !== version)
  throw new Error(`Quint ${version} required, got ${installed.version}`);
const cli = path.join(path.dirname(quintPackage), "dist/src/cli.js");
const output = testOutputPath(
  "cloud-formal",
  exhaustive ? "exhaustive" : symbolic ? "bounded" : "test",
  ...(selected ? [selected] : []),
);
mkdirSync(output, { recursive: true });
const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const results: Array<{
  model: string;
  command: string[];
  exitCode: number | null;
  error?: string;
}> = [];
const modelHashes = new Map<string, string>();
let failed = false;
for (const model of modelsToRun) {
  const file = path.join(formal, "models", model.file);
  modelHashes.set(
    model.id,
    createHash("sha256").update(readFileSync(file)).digest("hex"),
  );
  const serverPort = verifying
    ? await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("Could not allocate a model-checker port"));
            return;
          }
          server.close((error) =>
            error ? reject(error) : resolve(address.port),
          );
        });
      })
    : undefined;
  const commands = verifying
    ? [
        [
          "verify",
          file,
          `--invariant=${model.invariants.join(",")}`,
          "--verbosity=3",
          `--server-endpoint=127.0.0.1:${serverPort}`,
          "--apalache-version=0.62.4",
          ...(exhaustive
            ? ["--backend=tlc", `--tlc-config=${path.join(formal, "tlc.json")}`]
            : [`--max-steps=${model.maxSteps}`]),
        ],
      ]
    : [
        ["typecheck", file],
        [
          "test",
          file,
          "--backend=typescript",
          "--max-samples=100",
          "--seed=20261107",
        ],
        ...[20261107, 42, 314159].map((seed) => [
          "run",
          file,
          "--backend=typescript",
          `--invariant=${model.invariants.join(" and ")}`,
          "--max-samples=1000",
          `--max-steps=${model.maxSteps}`,
          `--seed=${seed}`,
        ]),
      ];
  for (const [index, args] of commands.entries()) {
    console.log(`${model.id}: ${args[0]}`);
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: output,
      encoding: "utf8",
      timeout: verifying ? 300_000 : 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(path.join(output, `${model.id}-${index}.log`), log);
    results.push({
      model: model.id,
      command: args,
      exitCode: result.status,
      error: result.error?.message,
    });
    if (result.status !== 0 || result.error) {
      failed = true;
      console.error(log);
      if (result.error) console.error(result.error.message);
      break;
    }
  }
  if (
    modelHashes.get(model.id) !==
    createHash("sha256").update(readFileSync(file)).digest("hex")
  ) {
    failed = true;
    console.error(`Model changed during validation: ${model.id}`);
  }
}
for (const model of modelsToRun) {
  const currentHash = createHash("sha256")
    .update(readFileSync(path.join(formal, "models", model.file)))
    .digest("hex");
  if (currentHash !== modelHashes.get(model.id)) {
    failed = true;
    console.error(`Model changed during the suite: ${model.id}`);
  }
}
writeFileSync(
  path.join(output, "results.json"),
  `${JSON.stringify(
    {
      version,
      sourceRevision,
      mode: exhaustive
        ? "finite-state-exhaustive"
        : symbolic
          ? "bounded-symbolic"
          : "sampled",
      models: modelsToRun.map((model) => ({
        ...model,
        sha256: modelHashes.get(model.id),
        sourceHashes: Object.fromEntries(
          model.sources.map((source) => [
            source,
            createHash("sha256")
              .update(readFileSync(path.join(root, source)))
              .digest("hex"),
          ]),
        ),
      })),
      results,
      passed: !failed,
    },
    null,
    2,
  )}\n`,
);
if (failed) process.exitCode = 1;
