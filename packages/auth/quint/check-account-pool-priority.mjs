/** Checks priority selection with the maintained real encrypted-account suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const auth = fileURLToPath(new URL("../", import.meta.url));
const suite = "src/accounts/multi-account-rotation.test.ts";
const output = testOutputPath("quint-account-pool-priority");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const result = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    suite,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: auth, encoding: "utf8", timeout: 360_000 },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(
  result.status,
  0,
  `Priority selection conformance failed. Evidence ${directory}`,
);
const cases = requireVitestConformance(
  JSON.parse(await readFile(report, "utf8")),
  path.join(auth, suite),
  [
    "surfaces TWO accounts per subscription tier (Claude + Codex) in list + describe",
    "serves coding credentials from ELIZA_HOME when the state dir is elsewhere",
    "round-robin alternates across the two Claude accounts (distinct tokens each turn)",
    "reordering priority changes which Claude account is served first",
    "priority filters scoped ids before ranking persisted priority and recency",
    "priority applies the completion clock at cooldown and subscription boundaries",
    "rate-limiting the active Claude account hands off to its sibling — no dropped request",
    "each Codex account materializes its OWN CODEX_HOME/auth.json — zero cross-account bleed",
    "each Claude account injects its OWN CLAUDE_CODE_OAUTH_TOKEN (no bleed)",
    "pool metadata (priority/enabled/usage) round-trips through _pool-metadata.json across a pool reset",
    "re-enabling a disabled account restores it to rotation",
  ].map((name) => `multi-account rotation E2E (#10696) ${name}`),
);
console.log(
  `Priority selection passed ${cases.length} real scratch-pool cases. Evidence ${directory}`,
);
