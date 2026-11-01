/**
 * Offline source audit of the production admission transfer. It never calls
 * Cloudflare or Wrangler.
 *
 * Each phase row of PRODUCTION-TRANSFER.md, the steady state and each reverse
 * step in admission-worker/reverse-transfer/ is checked three ways: that
 * tree's own validator accepts exactly its phase (and staging), it differs
 * from the step before only in admission ownership, and its production
 * variables equal Root's effective-variable receipts.
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
import { GATE_POLICY_VARIABLES } from "./production-admission-readback.ts";

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

/** Root's effective-variable receipts for the production API, merged. */
export function effectiveVariables(
  receipts: string[],
  script = "eliza-cloud-api-prod",
) {
  const merged = new Map<string, string>();
  for (const text of receipts) {
    const json = JSON.parse(text);
    const table = json?.effectiveFlags?.[script] ?? json?.flags?.[script];
    let entries: [string, unknown][];
    if (Array.isArray(json?.flags))
      entries = json.flags.map((flag: Config) => {
        if (flag?.type !== "plain_text")
          throw new Error(`Effective variable ${flag?.name} is not plain text`);
        return [flag.name, flag.text];
      });
    else if (table && typeof table === "object")
      entries = Object.entries(table);
    else
      throw new Error(`Unrecognized effective-variable receipt for ${script}`);
    for (const [name, value] of entries) {
      if (
        typeof value !== "string" ||
        (merged.has(name) && merged.get(name) !== value)
      )
        throw new Error(`Effective variable receipts disagree on ${name}`);
      merged.set(name, value);
    }
  }
  return merged;
}

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
  for (const name of GATE_POLICY_VARIABLES)
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { values } = parseArgs({
      options: {
        effective: { type: "string", multiple: true },
        steady: { type: "string", default: "HEAD" },
        commit: { type: "string", multiple: true },
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
      ),
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.some((entry) => entry.problems.length)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
