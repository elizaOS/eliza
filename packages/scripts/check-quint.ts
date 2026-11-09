/** Runs source-linked Quint cases. Full verification is the default. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseQuintShard, selectQuintShard } from "./lib/quint-shards.ts";
import { testOutputPath } from "./lib/test-output.ts";
import { MAX_TIMER_DELAY_MS, runWithDeadline } from "./run-with-deadline.ts";

const root = path.resolve(import.meta.dirname, "../..");
export const QUINT_VERSION = "0.33.1";
export const APALACHE_VERSION = "0.62.4";
const version = QUINT_VERSION;
const apalacheVersion = APALACHE_VERSION;
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_:]*$/);
const temporalCheckSchema = z
  .object({
    property: identifier,
    expect: z.enum(["holds", "counterexample"]),
    assumptions: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();
const caseSchema = z
  .object({
    name: z.string().min(1),
    main: identifier,
    init: identifier,
    step: identifier,
    invariants: z.array(identifier).min(1),
    temporal: z.array(identifier),
    temporalChecks: z.array(temporalCheckSchema).min(1).optional(),
    maxSteps: z.number().int().positive(),
    samples: z.number().int().positive(),
    deadlock: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    const checks = item.temporalChecks ?? [];
    const names = new Set(checks.map((check) => check.property));
    if (
      new Set(item.temporal).size !== item.temporal.length ||
      names.size !== checks.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate temporal property",
      });
    }
    if (
      item.temporal.some((name) => !names.has(name)) ||
      checks.some((check) => !item.temporal.includes(check.property))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Every temporal property requires an explicit expectation and assumptions",
      });
    }
  });
const manifestSchema = z.object({
  sources: z.array(z.string().min(1)).min(1),
  conformance: z
    .string()
    .regex(/\.(ts|js|mjs)$/)
    .optional(),
  cases: z.array(caseSchema).min(1),
  bounds: z.unknown().optional(),
});
const coverageSchema = z.array(
  z.object({
    id: z.string().min(1),
    model: z.string().nullable(),
    sources: z.array(z.string().min(1)),
    invariants: z.array(z.string()),
    status: z.enum(["modeled", "partial", "unmodeled"]),
    limitations: z.array(z.string()),
  }),
);
const ownerlessSourceSchema = z.array(
  z
    .object({
      source: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      reason: z.string().trim().min(1),
    })
    .strict(),
);
type ModelCase = z.infer<typeof caseSchema>;
type TemporalCheck = z.infer<typeof temporalCheckSchema>;
export type TemporalOutcome = "holds" | "counterexample" | "checker-error";

/** A checker error, timeout, or safety failure is not a temporal witness.
 * TLC checks always-state/action properties without a liveness graph pass.
 * Require both TLC completion and Quint's successful verifier receipt.
 */
export function classifyTemporalOutcome(
  status: number | null,
  output: string,
  error?: string,
): TemporalOutcome {
  if (error) return "checker-error";
  if (
    status === 0 &&
    output.includes("Model checking completed. No error has been found.") &&
    /\[ok\] No violation found/.test(output)
  )
    return "holds";
  if (
    status !== null &&
    status !== 0 &&
    /Temporal property q_temporalProps was violated/.test(output) &&
    /behavior constitutes a counter-example/.test(output) &&
    /Stuttering|Back to state/i.test(output) &&
    !/Invariant .* is violated/.test(output)
  )
    return "counterexample";
  return "checker-error";
}
type Model = {
  file: string;
  sources: string[];
  conformance?: string;
  cases: ModelCase[];
  bounds?: unknown;
};

class QuintCheckCancelled extends Error {
  readonly signal: "SIGINT" | "SIGTERM";

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`Quint verification cancelled by ${signal}`);
    this.name = "AbortError";
    this.signal = signal;
  }
}

function repositoryFiles(directory: string): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        file &&
        !file.startsWith("_apalache-out/") &&
        existsSync(path.join(directory, file)) &&
        statSync(path.join(directory, file)).isFile(),
    );
}

/** Bind manifests, imports, source helpers and runner code to one repository state. */
export function quintRepositoryFingerprint(directory: string): string {
  const gitOptions = {
    cwd: directory,
    maxBuffer: 128 * 1024 * 1024,
  };
  const head = execFileSync("git", ["rev-parse", "HEAD"], gitOptions);
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
      ".",
      ":(exclude,top)_apalache-out",
    ],
    gitOptions,
  );
  const untracked = execFileSync(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { ...gitOptions, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file && !file.startsWith("_apalache-out/"))
    .sort();
  const hash = createHash("sha256").update(
    JSON.stringify({
      head: head.toString("utf8").trim(),
      diff: createHash("sha256").update(diff).digest("hex"),
    }),
  );
  for (const file of untracked) {
    const contentHash = createHash("sha256")
      .update(readFileSync(path.join(directory, file)))
      .digest("hex");
    hash.update(JSON.stringify([file, contentHash]));
  }
  return hash.digest("hex");
}

export function requireQuintRepositoryFingerprint(
  directory: string,
  expected: string,
): void {
  if (quintRepositoryFingerprint(directory) !== expected) {
    throw new Error(
      "Repository changed during Quint verification; restart from the current source state",
    );
  }
}

function existingSource(directory: string, source: string): string {
  const relative = path.relative(directory, path.resolve(directory, source));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Model source escapes the repository: ${source}`);
  }
  if (
    !existsSync(path.join(directory, relative)) ||
    !statSync(path.join(directory, relative)).isFile()
  ) {
    throw new Error(`Model source does not exist: ${source}`);
  }
  return relative.split(path.sep).join("/");
}

export function loadQuintModels(directory: string): Model[] {
  const files = repositoryFiles(directory);
  const legacy = files.filter((file) => /\.(tla|pcal)$/i.test(file));
  if (legacy.length) {
    throw new Error(
      `Maintained formal models must use Quint: ${legacy.join(", ")}`,
    );
  }
  const models = files
    .filter((file) => file.endsWith(".cases.json"))
    .sort()
    .map((manifest) => {
      const file = manifest.replace(/\.cases\.json$/, ".qnt");
      if (!files.includes(file)) {
        throw new Error(`Missing Quint specification for ${manifest}`);
      }
      const data = manifestSchema.parse(
        JSON.parse(readFileSync(path.join(directory, manifest), "utf8")),
      );
      const names = new Set<string>();
      for (const item of data.cases) {
        if (names.has(item.name)) {
          throw new Error(`Duplicate Quint case ${item.name} in ${manifest}`);
        }
        names.add(item.name);
        if (item.deadlock && !item.temporal.includes("DeadlockFree")) {
          throw new Error(`Missing DeadlockFree property in ${manifest}`);
        }
        if (
          item.deadlock &&
          !item.temporalChecks?.some(
            (check) =>
              check.property === "DeadlockFree" && check.expect === "holds",
          )
        ) {
          throw new Error(
            `DeadlockFree must be expected to hold in ${manifest}`,
          );
        }
      }
      const sources = data.sources.map((source) =>
        existingSource(directory, source),
      );
      const conformance = data.conformance
        ? existingSource(directory, data.conformance)
        : undefined;
      return {
        file,
        sources,
        conformance,
        cases: data.cases,
        bounds: data.bounds,
      };
    });
  for (const file of files.filter((candidate) => candidate.endsWith(".qnt"))) {
    if (!models.some((model) => model.file === file)) {
      throw new Error(`Quint specification has no checked cases: ${file}`);
    }
  }
  if (models.length === 0) throw new Error("No Quint specifications found");
  return models;
}

export function selectQuintModels(
  models: Model[],
  selected: string[],
): Model[] {
  for (const name of selected) {
    if (
      !models.some(
        (model) =>
          model.file === name ||
          model.file.startsWith(`${name}/`) ||
          path.basename(model.file, ".qnt") === name,
      )
    ) {
      throw new Error(`Unknown Quint specification: ${name}`);
    }
  }
  return models.filter(
    (model) =>
      selected.length === 0 ||
      selected.includes(model.file) ||
      selected.some((name) => model.file.startsWith(`${name}/`)) ||
      selected.includes(path.basename(model.file, ".qnt")),
  );
}

export function createQuintInventory(directory: string, models: Model[]) {
  const files = repositoryFiles(directory);
  const coverage = files
    .filter((file) => /\/quint\/[^/]*coverage\.json$/.test(file))
    .flatMap((file) =>
      coverageSchema.parse(
        JSON.parse(readFileSync(path.join(directory, file), "utf8")),
      ),
    );
  const coverageSources = new Set<string>();
  for (const entry of coverage) {
    const sources = entry.sources.map((source) =>
      existingSource(directory, source),
    );
    for (const source of sources) coverageSources.add(source);
    const modelFile =
      entry.model &&
      path
        .relative(directory, path.resolve(directory, entry.model))
        .split(path.sep)
        .join("/");
    const model = models.find((candidate) => candidate.file === modelFile);
    if (entry.model && !model) {
      throw new Error(
        `Coverage entry ${entry.id} references an unchecked model: ${entry.model}`,
      );
    }
    if (entry.status === "modeled" && !entry.model) {
      throw new Error(`Coverage entry ${entry.id} has no model`);
    }
    const checkedInvariants = new Set(
      model?.cases.flatMap((item) => item.invariants),
    );
    for (const invariant of entry.invariants) {
      if (!checkedInvariants.has(invariant)) {
        throw new Error(
          `Coverage entry ${entry.id} claims unchecked invariant: ${invariant}`,
        );
      }
    }
    if (entry.status === "modeled") {
      for (const source of sources) {
        if (!model?.sources.includes(source)) {
          throw new Error(
            `Coverage entry ${entry.id} claims an unlinked source: ${source}`,
          );
        }
      }
    }
  }
  const candidates = files
    .filter(
      (file) =>
        /^(packages|plugins)\//.test(file) &&
        /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|kt|java|go|swift|rs|cpp|cc|cxx|c|h|hpp|m|mm|py|sh|sql)$/.test(
          file,
        ) &&
        !/(^|\/)(test|tests|__tests__|fixtures|vendor|generated|dist|node_modules)(\/|$)/.test(
          file,
        ) &&
        !/\.(test|spec)\./.test(file),
    )
    .filter((file) =>
      /\b(?:state|status|phase)\s*\??\s*[:=;]|\buseState\b|\buseReducer\b|\btransition\b|\blifecycle\b|\b(?:class|interface|type|enum)\s+(?:class\s+)?\w*(?:State|Status|Phase)\w*\b|\b(?:state|status|phase)\s+(?:TEXT|VARCHAR|INTEGER|BOOLEAN)\b/i.test(
        readFileSync(path.join(directory, file), "utf8"),
      ),
    )
    .map((file) => ({
      file,
      referencedBy: models
        .filter((model) => model.sources.includes(file))
        .map((model) => model.file),
    }));
  const candidatesByFile = new Map(
    candidates.map((candidate) => [candidate.file, candidate]),
  );
  const repositoryPath = realpathSync(directory);
  const ownerlessSources = files
    .filter((file) => file.endsWith("/quint/ownerless-sources.json"))
    .flatMap((file) => {
      const reviewPath = path.join(repositoryPath, file);
      if (realpathSync(reviewPath) !== reviewPath) {
        throw new Error(
          `Quint ownerless review must use its real path: ${file}`,
        );
      }
      return ownerlessSourceSchema.parse(
        JSON.parse(readFileSync(reviewPath, "utf8")),
      );
    });
  const reviewed = new Set<string>();
  for (const { source, sha256 } of ownerlessSources) {
    if (reviewed.has(source)) {
      throw new Error(`Duplicate Quint ownerless source review: ${source}`);
    }
    const candidate = candidatesByFile.get(source);
    if (!candidate) {
      throw new Error(
        `Quint ownerless source is not an inventory candidate: ${source}`,
      );
    }
    if (candidate.referencedBy.length || coverageSources.has(source)) {
      throw new Error(
        `Quint ownerless source conflicts with a model or coverage entry: ${source}`,
      );
    }
    const sourcePath = path.join(repositoryPath, source);
    if (realpathSync(sourcePath) !== sourcePath) {
      throw new Error(
        `Quint ownerless source must use its real path: ${source}`,
      );
    }
    const actualHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    if (actualHash !== sha256) {
      throw new Error(`Stale Quint ownerless source review: ${source}`);
    }
    reviewed.add(source);
  }
  const unreferencedCandidates = candidates.filter(
    (item) => item.referencedBy.length === 0,
  ).length;
  const inventory = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim(),
    candidateDiscovery:
      "Source-pattern candidates require human review. A model reference does not establish complete source coverage.",
    models,
    coverage,
    declaredGaps: coverage.filter((entry) => entry.status !== "modeled").length,
    candidates,
    unreferencedCandidates,
    ownerlessSources,
    unreviewedCandidates: unreferencedCandidates - reviewed.size,
  };
  return inventory;
}

function writeInventory(
  directory: string,
  outputDirectory: string,
  models: Model[],
  repositorySha256: string,
) {
  const inventory = createQuintInventory(directory, models);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    path.join(outputDirectory, "inventory.json"),
    `${JSON.stringify({ ...inventory, repositorySha256 }, null, 2)}\n`,
  );
  return inventory;
}

async function availableEndpoint(): Promise<string> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a Quint compiler port"));
        return;
      }
      const endpoint = `127.0.0.1:${address.port}`;
      server.close((error) => (error ? reject(error) : resolve(endpoint)));
    });
  });
}

export async function main(
  args: string[],
  directory = root,
  outputDirectory = testOutputPath("quint"),
): Promise<void> {
  const options = new Set(["--simulate", "--inventory", "--require-complete"]);
  const shardArguments = args.filter((arg) => arg.startsWith("--shard="));
  if (shardArguments.length > 1)
    throw new Error("Only one Quint shard may be selected");
  const shard = shardArguments[0]
    ? parseQuintShard(shardArguments[0])
    : undefined;
  for (const arg of args) {
    if (
      arg.startsWith("-") &&
      !options.has(arg) &&
      !shardArguments.includes(arg)
    ) {
      throw new Error(`Unknown Quint option: ${arg}`);
    }
  }
  if (shard && outputDirectory === testOutputPath("quint")) {
    outputDirectory = path.join(
      outputDirectory,
      `shard-${shard.index}-of-${shard.count}`,
    );
  }
  const simulate = args.includes("--simulate");
  if (!args.includes("--inventory")) {
    rmSync(
      path.join(
        outputDirectory,
        simulate ? "simulation.json" : "verification.json",
      ),
      { force: true },
    );
  }
  const repositorySha256 = quintRepositoryFingerprint(directory);
  const allModels = loadQuintModels(directory);
  const selectedModels = selectQuintModels(
    allModels,
    args.filter((arg) => !arg.startsWith("-")),
  );
  const models = shard
    ? selectQuintShard(selectedModels, shard)
    : selectedModels;
  const inventory = writeInventory(
    directory,
    outputDirectory,
    allModels,
    repositorySha256,
  );
  requireQuintRepositoryFingerprint(directory, repositorySha256);
  if (
    args.includes("--require-complete") &&
    (inventory.unreviewedCandidates > 0 || inventory.declaredGaps > 0)
  ) {
    throw new Error(
      `${inventory.unreviewedCandidates} unreviewed source candidates and ${inventory.declaredGaps} declared gaps still need coverage review. See test-results/quint/inventory.json`,
    );
  }
  if (args.includes("--inventory")) {
    console.log(
      `${allModels.length} models, ${inventory.ownerlessSources.length} reviewed ownerless sources, ${inventory.unreviewedCandidates} unreviewed source candidates`,
    );
    return;
  }

  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("@informalsystems/quint/package.json");
  const installed = JSON.parse(readFileSync(packageFile, "utf8"));
  if (installed.version !== version) {
    throw new Error(`Quint ${version} is required; found ${installed.version}`);
  }
  const cli = path.resolve(path.dirname(packageFile), installed.bin.quint);
  const modelInputs = new Map(
    models.map((model) => {
      const files = [
        model.file,
        model.file.replace(/\.qnt$/, ".cases.json"),
        ...model.sources,
        ...(model.conformance ? [model.conformance] : []),
      ];
      return [
        model,
        Object.fromEntries(
          files.map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(path.join(directory, file)))
              .digest("hex"),
          ]),
        ),
      ] as const;
    }),
  );
  requireQuintRepositoryFingerprint(directory, repositorySha256);
  const results: object[] = [];
  const failures: string[] = [];
  let completed = false;
  const report = () => {
    const observedRepositorySha256 = quintRepositoryFingerprint(directory);
    const repositoryChanged = observedRepositorySha256 !== repositorySha256;
    writeFileSync(
      path.join(
        outputDirectory,
        simulate ? "simulation.json" : "verification.json",
      ),
      `${JSON.stringify({ quintVersion: version, apalacheVersion: simulate ? null : apalacheVersion, mode: simulate ? "simulation" : "exhaustive-tlc", repositorySha256, observedRepositorySha256, ...(shard ? { shard: { ...shard, models: models.map((model) => model.file), allModels: allModels.map((model) => model.file) } } : {}), completed: completed && !repositoryChanged, results }, null, 2)}\n`,
    );
    if (completed && repositoryChanged) {
      throw new Error(
        "Repository changed while writing Quint verification evidence",
      );
    }
  };

  try {
    report();
    for (const model of models) {
      for (const item of model.cases) {
        const key = `${model.file}#${item.name}`;
        const common = [path.join(directory, model.file), "--main", item.main];
        const endpoint = simulate ? undefined : await availableEndpoint();
        const commands = [
          ["typecheck", path.join(directory, model.file)],
          ["test", ...common, "--backend", "typescript", "--seed", "20261107"],
          [
            simulate ? "run" : "verify",
            ...common,
            "--init",
            item.init,
            "--step",
            item.step,
            ...(simulate
              ? [
                  "--backend",
                  "typescript",
                  "--seed",
                  "20261107",
                  "--max-samples",
                  String(item.samples),
                  "--max-steps",
                  String(item.maxSteps),
                ]
              : [
                  "--backend",
                  "tlc",
                  "--apalache-version",
                  apalacheVersion,
                  "--tlc-config",
                  path.join(directory, "packages/scripts/quint/tlc.json"),
                  "--server-endpoint",
                  endpoint as string,
                  "--verbosity",
                  "3",
                ]),
            "--invariants",
            ...item.invariants,
          ],
          ...(model.conformance && item === model.cases.at(-1)
            ? [["conformance", model.conformance]]
            : []),
        ];
        // Keep existing positive formulas grouped with safety. Negative checks
        // run separately so one expected witness cannot hide another outcome.
        const temporalCommands = new Map<string[], TemporalCheck[]>();
        if (!simulate) {
          const safetyCommand = [...commands[2]];
          const positive = (item.temporalChecks ?? []).filter(
            (check) => check.expect === "holds",
          );
          if (positive.length) {
            commands[2].push(
              "--temporal",
              positive.map((check) => check.property).join(","),
            );
            temporalCommands.set(commands[2], positive);
          }
          const checks = (item.temporalChecks ?? [])
            .filter((check) => check.expect === "counterexample")
            .map((check) => {
              const command = [...safetyCommand, "--temporal", check.property];
              temporalCommands.set(command, [check]);
              return command;
            });
          commands.splice(3, 0, ...checks);
        }
        let passed = true;
        for (const [commandIndex, command] of commands.entries()) {
          const temporalChecks = temporalCommands.get(command);
          const expectedTemporalOutcome = temporalChecks?.[0].expect;
          requireQuintRepositoryFingerprint(directory, repositorySha256);
          console.log(
            `${key} ${command[0]}${temporalChecks ? ` ${temporalChecks.map((check) => check.property).join(",")} (expected ${expectedTemporalOutcome})` : ""}`,
          );
          const hashes = modelInputs.get(model);
          const started = Date.now();
          const result = spawnSync(
            process.execPath,
            command[0] === "conformance"
              ? [command[1], model.file]
              : [cli, ...command],
            {
              cwd: command[0] === "conformance" ? directory : outputDirectory,
              env: {
                ...process.env,
                JVM_ARGS: process.env.JVM_ARGS ?? "-Xmx1G -Xss8m",
              },
              encoding: "utf8",
              maxBuffer: 64 * 1024 * 1024,
            },
          );
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          const log = `${createHash("sha256").update(key).digest("hex").slice(0, 16)}-${commandIndex}-${command[0]}.log`;
          writeFileSync(path.join(outputDirectory, log), output);
          const repositorySha256After = quintRepositoryFingerprint(directory);
          const repositoryChanged = repositorySha256After !== repositorySha256;
          const observedTemporalOutcome = temporalChecks
            ? classifyTemporalOutcome(
                result.status,
                output,
                result.error?.message,
              )
            : undefined;
          const matchedExpectation = temporalChecks
            ? observedTemporalOutcome === expectedTemporalOutcome
            : !result.error && result.status === 0;
          results.push({
            key,
            bounds: model.bounds,
            configuration: item,
            command,
            inputSha256: hashes,
            repositorySha256After,
            repositoryChanged,
            exitCode: result.status,
            signal: result.signal,
            error: result.error?.message,
            durationMs: Date.now() - started,
            log,
            temporalProperties: temporalChecks?.map((check) => check.property),
            expectedTemporalOutcome,
            observedTemporalOutcome,
            temporalAssumptions: temporalChecks?.map((check) => ({
              property: check.property,
              assumptions: check.assumptions,
            })),
            matchedExpectation,
          });
          report();
          if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
            throw new QuintCheckCancelled(result.signal);
          }
          if (repositoryChanged) {
            throw new Error(
              `Repository changed during ${key} ${command[0]}; restart Quint verification`,
            );
          }
          if (!matchedExpectation) {
            passed = false;
            failures.push(`${key} ${command[0]}`);
            console.error(output);
            break;
          }
        }
        console.log(`${passed ? "PASS" : "FAIL"} ${key}`);
      }
    }
    if (failures.length)
      throw new Error(`Quint checks failed\n${failures.join("\n")}`);
    requireQuintRepositoryFingerprint(directory, repositorySha256);
    completed = true;
  } finally {
    report();
  }
}

/** Keep group ownership in this responsive controller until every child is gone. */
function superviseQuintCli(args: string[]): void {
  runWithDeadline(
    [
      String(MAX_TIMER_DELAY_MS),
      "--",
      process.execPath,
      fileURLToPath(import.meta.url),
      "--quint-worker",
      ...args,
    ],
    // Leave room for the two-second reap check before an enclosing default
    // ten-second supervisor can terminate this controller.
    3_000,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "--quint-worker") {
      await main(process.argv.slice(3));
    } else {
      await superviseQuintCli(process.argv.slice(2));
    }
  } catch (error) {
    if (!(error instanceof QuintCheckCancelled)) throw error;
    console.error(error.message);
    process.exitCode = error.signal === "SIGINT" ? 130 : 143;
  }
}
