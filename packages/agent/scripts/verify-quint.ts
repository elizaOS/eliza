/** Check every agent specification and retain reproducible, fail-closed evidence. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const version = "0.33.1";
const packageRoot = path.resolve(import.meta.dirname, "..");
const formalRoot = path.join(packageRoot, "formal");
const outputRoot = testOutputPath("agent-quint");
const logRoot = path.join(outputRoot, "checks");
mkdirSync(logRoot, { recursive: true });
writeFileSync(
  path.join(outputRoot, "verification.json"),
  JSON.stringify(
    {
      quintVersion: version,
      generatedAt: new Date().toISOString(),
      complete: false,
      checks: [],
    },
    null,
    2,
  ),
);

const require = createRequire(import.meta.url);
const cli =
  process.env.QUINT_CLI ??
  (() => {
    const manifestPath = require.resolve("@informalsystems/quint/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin: { quint: string };
    };
    return path.resolve(path.dirname(manifestPath), manifest.bin.quint);
  })();

type Check = {
  name: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  passed: boolean;
  log: string;
};
const checks: Check[] = [];
async function verifierEndpoint(): Promise<string[]> {
  // Other workspace audits can run Quint concurrently. Each invocation owns a
  // fresh local endpoint instead of racing the shared default Apalache port.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("No verifier port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return ["--server-endpoint", `127.0.0.1:${address.port}`];
}

function check(
  name: string,
  args: string[],
  expectedViolation = false,
): string {
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: outputRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  // A failed verifier is a negative control only when it reports a real invariant
  // violation. Syntax, dependency, timeout and infrastructure errors never pass.
  const passed = expectedViolation
    ? result.status !== 0 &&
      result.status !== null &&
      /Error: Invariant [^\n]+ is violated\./.test(output)
    : result.status === 0;
  const log = path.join(logRoot, `${name}.log`);
  writeFileSync(log, output);
  checks.push({
    name,
    args,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Math.round(performance.now() - start),
    passed,
    log: path.relative(outputRoot, log),
  });
  writeFileSync(
    path.join(outputRoot, "verification.json"),
    JSON.stringify(
      {
        quintVersion: version,
        generatedAt: new Date().toISOString(),
        complete: false,
        checks,
      },
      null,
      2,
    ),
  );
  if (!passed) throw new Error(`${name} failed. See ${log}`);
  console.log(`[quint] ${name}: passed`);
  return output;
}

const actualVersion = check("toolchain", ["--version"]).trim();
if (actualVersion !== version)
  throw new Error(`Expected Quint ${version}; got ${actualVersion}`);
const files = readdirSync(formalRoot)
  .filter((file) => file.endsWith(".qnt"))
  .sort();
if (files.length === 0) throw new Error("No agent Quint specifications found");
const models = files.map((file) => {
  const source = readFileSync(path.join(formalRoot, file), "utf8");
  const main = /^module\s+(\w+)\s*\{/m.exec(source)?.[1];
  if (!main) throw new Error(`${file} has no main module`);
  const tests = [...source.matchAll(/^\s*run\s+(\w+Test)\s*=/gm)].map(
    (match) => match[1],
  );
  if (tests.length === 0) throw new Error(`${file} has no scenario runs`);
  return {
    file,
    main,
    tests,
    sha256: createHash("sha256").update(source).digest("hex"),
    negativeControl: /^\s*action\s+legacyStep\s*=/m.test(source),
  };
});

// Fail fast on any parse/type problem before starting expensive model checking.
for (const model of models) {
  check(`${model.main}-types`, [
    "typecheck",
    path.join(formalRoot, model.file),
  ]);
}
for (const model of models) {
  const input = path.join(formalRoot, model.file);
  const common = [input, "--main", model.main];
  const testOutput = check(`${model.main}-scenarios`, [
    "test",
    ...common,
    "--backend",
    "typescript",
    "--seed",
    "42",
    "--max-samples",
    "100",
    "--verbosity",
    "1",
  ]);
  if (!/\b[1-9]\d* passing\b/.test(testOutput))
    throw new Error(`${model.file}: no successful scenarios reported`);
  check(`${model.main}-simulation`, [
    "run",
    ...common,
    "--backend",
    "typescript",
    "--seed",
    "42",
    "--max-samples",
    "200",
    "--max-steps",
    "50",
    "--invariant",
    "safety",
    "--verbosity",
    "1",
  ]);
  check(`${model.main}-exhaustive`, [
    "verify",
    ...common,
    ...(await verifierEndpoint()),
    "--backend",
    "tlc",
    "--invariant",
    "safety",
    "--verbosity",
    "3",
  ]);
  if (model.negativeControl) {
    check(
      `${model.main}-negative-control`,
      [
        "verify",
        ...common,
        ...(await verifierEndpoint()),
        "--backend",
        "tlc",
        "--step",
        "legacyStep",
        "--invariant",
        "safety",
        "--verbosity",
        "3",
      ],
      true,
    );
  }
}
for (const model of models) {
  const current = createHash("sha256")
    .update(readFileSync(path.join(formalRoot, model.file)))
    .digest("hex");
  if (current !== model.sha256)
    throw new Error(
      `${model.file} changed during verification; rerun the suite`,
    );
}
if (
  JSON.stringify(
    readdirSync(formalRoot)
      .filter((file) => file.endsWith(".qnt"))
      .sort(),
  ) !== JSON.stringify(files)
) {
  throw new Error(
    "Model inventory changed during verification; rerun the suite",
  );
}
writeFileSync(
  path.join(outputRoot, "verification.json"),
  JSON.stringify(
    {
      quintVersion: version,
      generatedAt: new Date().toISOString(),
      complete: true,
      method:
        "TLC exhaustive finite-state invariant checking (no depth bound); deterministic scenarios; seeded simulation; legacy negative controls",
      models,
      checks,
    },
    null,
    2,
  ),
);
console.log(`[quint] ${models.length} models passed; evidence: ${outputRoot}`);
