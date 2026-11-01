/**
 * Offline source audit of the production admission transfer. It never calls
 * Cloudflare or Wrangler.
 *
 * Each phase row of PRODUCTION-TRANSFER.md, the steady state and each reverse
 * step in admission-worker/reverse-transfer/ is checked three ways: that
 * tree's own validator accepts exactly its phase (and staging), it differs
 * from the step before only in admission ownership, and its production
 * variables equal Root's effective-variable receipts. At gate 2 it also
 * proves the phase 2 main commit is live main plus the phase 2 change, with
 * the frozen target's admission bundle sources.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  effectiveVariables,
  UNCARRIED_GATE_VARIABLES,
} from "./production-admission-readback.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
export const API_CONFIG = "packages/cloud/api/wrangler.toml";
export const TARGET_CONFIG = "packages/cloud/admission-worker/wrangler.toml";
const VALIDATOR = "packages/cloud/admission-worker/verify-staging-contract.ts";
const RUNBOOK = "packages/cloud/admission-worker/PRODUCTION-TRANSFER.md";
const REVERSE_DIR = "packages/cloud/admission-worker/reverse-transfer";
// Every file the validator reads; a missing one fails the validator closed.
export const VALIDATOR_INPUTS = [
  API_CONFIG,
  TARGET_CONFIG,
  VALIDATOR,
  "packages/cloud/admission-worker/src/index.ts",
  "packages/cloud/api/src/inference-admission-gate.ts",
  "packages/cloud/api/src/inference-funded-budget-controller.ts",
  "packages/cloud/api/src/speech-revocation-registry.ts",
  "packages/cloud/api/src/maps-request-allowance-controller.ts",
  "packages/cloud/shared/src/lib/services/maps-request-policy.ts",
  "packages/cloud/shared/src/lib/services/plan-request-limiter.ts",
];
// Repository sources of the admission Worker bundle (Wrangler's metafile of
// the phase 1 dry run, by directory) and the manifests that pin its
// dependencies. Equal sources build the same gate code.
export const ADMISSION_BUNDLE_SOURCES = [
  "bun.lock",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "packages/auth",
  "packages/cloud/admission-worker/src",
  "packages/cloud/api/package.json",
  "packages/cloud/api/src",
  "packages/cloud/sdk",
  "packages/cloud/services",
  "packages/cloud/shared",
  "packages/contracts",
  "packages/core",
  "plugins/plugin-native-inference",
  "plugins/plugin-sql",
  "plugins/plugin-todos",
];

export type Files = Record<string, string>;
export interface PhaseSource {
  phase: string;
  commit: string;
  files: Files;
}
// biome-ignore lint/suspicious/noExplicitAny: parsed TOML is untyped.
type Config = Record<string, any>;

function git(args: string[], cwd = repoRoot) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function commitFiles(commit: string): Files {
  return Object.fromEntries(
    VALIDATOR_INPUTS.map((path) => [path, git(["show", `${commit}:${path}`])]),
  );
}

/** `phase` and full commit of each row in the runbook's phase table. */
export function runbookPhases(markdown: string) {
  return [
    ...markdown.matchAll(
      /^\|[^|\n]*\| `([0-9a-f]{40})` \|[^|\n]*\| `([a-z-]+)` \|$/gm,
    ),
  ].map(([, commit, phase]) => ({ phase, commit }));
}

/** Applies one reverse step to a copy of `files`; every patched file must change. */
export function applyPatch(files: Files, patch: string): Files {
  const directory = mkdtempSync(join(tmpdir(), "admission-reverse-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    writeFileSync(join(directory, ".step.patch"), patch);
    // Outside any repository, git applies paths relative to this directory.
    const result = spawnSync("git", ["apply", ".step.patch"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) },
    });
    if (result.status !== 0)
      throw new Error(`Reverse patch does not apply: ${result.stderr.trim()}`);
    const patched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
      ([, path]) => path,
    );
    const next = { ...files };
    for (const path of patched) {
      next[path] = readFileSync(join(directory, path), "utf8");
      if (next[path] === files[path])
        throw new Error(`Reverse patch left ${path} unchanged`);
    }
    return next;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The reverse steps, in order, each applied on top of the one before. */
export function reverseChain(
  steady: Files,
  patches: [name: string, text: string][],
) {
  let files = steady;
  return patches
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, text]) => {
      const phase = name.match(/^R\d-([a-z-]+)\.patch$/)?.[1];
      if (!phase) throw new Error(`Unexpected reverse step ${name}`);
      files = applyPatch(files, text);
      return { phase, commit: `${name} on steady state`, files };
    });
}

function runValidator(files: Files, args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "admission-phase-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    const result = spawnSync(
      process.execPath,
      [join(directory, VALIDATOR), ...args],
      { cwd: directory, encoding: "utf8" },
    );
    const output =
      result.status === 0
        ? result.stdout.trim()
        : (`${result.stderr}${result.stdout}`.match(/^error: .+$/m)?.[0] ??
          `exit ${result.status}`);
    return { ok: result.status === 0, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Wrangler inherits these top-level keys into an environment, as the validator resolves them.
const INHERITED = [
  "main",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "routes",
  "migrations",
  "exports",
];

/** The whole config with `env.production` resolved; bindings keyed by name. */
export function configView(text: string): Config {
  const config = Bun.TOML.parse(text) as Config;
  const { production, ...environments } = config.env ?? {};
  const resolved: Config | undefined = production && {
    ...Object.fromEntries(INHERITED.map((key) => [key, config[key]])),
    ...production,
  };
  return {
    ...config,
    env: environments,
    production: resolved && {
      ...resolved,
      migrations: resolved.migrations?.length ? resolved.migrations : undefined,
      durable_objects: resolved.durable_objects && {
        ...resolved.durable_objects,
        bindings: Object.fromEntries(
          (resolved.durable_objects.bindings ?? []).map((binding: Config) => [
            binding.name,
            binding,
          ]),
        ),
      },
    },
  };
}

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );

/** Dotted paths of every leaf that differs. */
export function differences(
  before: unknown,
  after: unknown,
  path: string[] = [],
): string[] {
  if (canonical(before) === canonical(after)) return [];
  const isTable = (value: unknown): value is Config =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!isTable(before) || !isTable(after)) return [path.join(".")];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((key) => differences(before[key], after[key], [...path, key]));
}

const ADMISSION_PATHS = [
  "production.exports.InferenceAdmissionGate",
  "production.durable_objects.bindings.INFERENCE_ADMISSION_GATES",
];

/**
 * Every effective variable keeps its value in the API, and in the target
 * wherever it carries the name. Gate policy flags stay unset unless the
 * receipts set them. Each deploy publishes its own ELIZA_DEPLOY_COMMIT.
 */
export function effectiveDrift(
  api: Config | undefined,
  target: Config | undefined,
  effective: Map<string, string>,
) {
  const problems: string[] = [];
  const sides: [string, Config | undefined][] = [
    ["API", api?.vars ?? {}],
    ["target", target?.vars],
  ];
  for (const [name, value] of effective) {
    if (name === "ELIZA_DEPLOY_COMMIT") continue;
    for (const [side, vars] of sides)
      if (vars && (side === "API" || name in vars) && vars[name] !== value)
        problems.push(`${side} ${name} is ${vars[name]}, effective ${value}`);
  }
  for (const name of UNCARRIED_GATE_VARIABLES)
    if (!effective.has(name))
      for (const [side, vars] of sides)
        if (vars?.[name] !== undefined)
          problems.push(`${side} sets ${name}, which production leaves unset`);
  return problems;
}

export function auditChain(
  chain: PhaseSource[],
  effective: Map<string, string>,
) {
  let previous: { phase: string; api: Config; target: Config } | undefined;
  return chain.map(({ phase, commit, files }) => {
    const api = configView(files[API_CONFIG]);
    const target = configView(files[TARGET_CONFIG]);
    const problems: string[] = [];
    // The base predates the production validator; it is the live source.
    const validator =
      phase === "source-owned"
        ? undefined
        : [
            runValidator(files, ["--production", "--phase", phase]),
            runValidator(files, []),
          ];
    for (const result of validator ?? [])
      if (!result.ok) problems.push(`validator: ${result.output}`);
    const changes = previous && {
      api: differences(previous.api, api),
      target: differences(previous.target, target),
    };
    for (const [side, paths] of Object.entries(changes ?? {}))
      for (const path of paths)
        if (
          !ADMISSION_PATHS.some(
            (allowed) => path === allowed || path.startsWith(`${allowed}.`),
          ) &&
          !(
            side === "target" &&
            path === "production" &&
            !previous?.target.production
          )
        )
          problems.push(`${side} changes outside admission: ${path}`);
    problems.push(
      ...effectiveDrift(api.production, target.production, effective),
    );
    previous = { phase, api, target };
    return {
      phase,
      commit,
      validator: validator?.map((result) => result.output),
      changes,
      apiOnlyEffective: [...effective.keys()].filter(
        (name) =>
          name !== "ELIZA_DEPLOY_COMMIT" &&
          !(name in (target.production?.vars ?? {})),
      ),
      problems,
    };
  });
}

/**
 * Gate 2. The phase 2 commit on `main` must be live `main` plus only the
 * paths of the frozen phase 2 change, and build the admission bundle from
 * the same sources as the target that serves the namespace once it commits.
 * `live` is Root's phase 1 receipt (R1), which names the API's served commit.
 */
export function mainMergeProblems(facts: {
  firstParent: string;
  liveMain: string;
  live: { phase?: unknown; api?: { commit?: unknown } };
  mergePaths: string[];
  phasePaths: string[];
  bundlePaths: string[];
}) {
  const problems: string[] = [];
  if (facts.live.phase !== "target-pending")
    problems.push(
      `live receipt is ${String(facts.live.phase)}, not target-pending`,
    );
  if (facts.live.api?.commit !== facts.liveMain)
    problems.push(
      `the API serves ${String(facts.live.api?.commit)}, not live main ${facts.liveMain}`,
    );
  if (facts.firstParent !== facts.liveMain)
    problems.push(
      `first parent ${facts.firstParent} is not live main ${facts.liveMain}`,
    );
  for (const path of facts.mergePaths)
    if (!facts.phasePaths.includes(path))
      problems.push(`merge changes ${path} outside the phase 2 change`);
  for (const path of facts.bundlePaths)
    problems.push(`admission bundle source differs from the target: ${path}`);
  return problems;
}

const changedPaths = (from: string, to: string, paths: string[] = []) =>
  git(["diff", "--name-only", from, to, "--", ...paths])
    .split("\n")
    .filter(Boolean);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { values } = parseArgs({
      options: {
        effective: { type: "string", multiple: true },
        steady: { type: "string", default: "HEAD" },
        commit: { type: "string", multiple: true },
        live: { type: "string" },
      },
    });
    if (!values.effective?.length)
      throw new Error(
        "Pass Root's receipts with --effective <path> (repeatable)",
      );
    const steady = git([
      "rev-parse",
      "--verify",
      `${values.steady}^{commit}`,
    ]).trim();
    const overrides = new Map(
      (values.commit ?? []).map((item) => {
        const [phase, commit] = item.split("=");
        if (!/^[0-9a-f]{40}$/.test(commit ?? ""))
          throw new Error("--commit takes <phase>=<40-character SHA>");
        return [phase, commit];
      }),
    );
    const rows = runbookPhases(git(["show", `${steady}:${RUNBOOK}`]));
    for (const phase of overrides.keys())
      if (!rows.some((row) => row.phase === phase))
        throw new Error(`The runbook has no ${phase} row`);
    const forward = rows.map(({ phase, commit }) => {
      const pinned = overrides.get(phase) ?? commit;
      return { phase, commit: pinned, files: commitFiles(pinned) };
    });
    const steadyFiles = commitFiles(steady);
    const patches = git(["ls-tree", "--name-only", `${steady}:${REVERSE_DIR}`])
      .split("\n")
      .filter(Boolean)
      .map((name): [string, string] => [
        name,
        git(["show", `${steady}:${REVERSE_DIR}/${name}`]),
      ]);
    const report = auditChain(
      [
        ...forward,
        { phase: "adopted", commit: steady, files: steadyFiles },
        ...reverseChain(steadyFiles, patches),
      ],
      effectiveVariables(
        values.effective.map((path) => readFileSync(path, "utf8")),
      ).variables,
    );
    const gates: { gate: string; commit: string; problems: string[] }[] = [];
    const phaseTwoMain = overrides.get("source-commit");
    if (phaseTwoMain) {
      const liveMain = overrides.get("source-owned");
      if (!liveMain || !values.live)
        throw new Error(
          "Gate 2 needs --commit source-owned=<live main SHA> and --live <R1 receipt>",
        );
      const row = (phase: string) =>
        rows.find((item) => item.phase === phase)?.commit ?? "";
      gates.push({
        gate: "2: phase 2 main merge",
        commit: phaseTwoMain,
        problems: mainMergeProblems({
          firstParent: git(["rev-parse", `${phaseTwoMain}^1`]).trim(),
          liveMain,
          live: JSON.parse(readFileSync(values.live, "utf8")),
          mergePaths: changedPaths(liveMain, phaseTwoMain),
          phasePaths: changedPaths(row("source-owned"), row("source-commit")),
          bundlePaths: changedPaths(
            row("target-pending"),
            phaseTwoMain,
            ADMISSION_BUNDLE_SOURCES,
          ),
        }),
      });
      if (values.steady !== "HEAD") {
        const parent = git(["rev-parse", `${steady}^1`]).trim();
        gates.push({
          gate: "3: steady state main merge",
          commit: steady,
          problems:
            parent === phaseTwoMain
              ? []
              : [`first parent ${parent} is not the phase 2 main commit`],
        });
      }
    }
    console.log(JSON.stringify([...report, ...gates], null, 2));
    if ([...report, ...gates].some((entry) => entry.problems.length))
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
