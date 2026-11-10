/** Checks default-pool generation and health through real HTTP and encrypted files. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "packages/auth/quint/AccountPoolHealth.qnt";
const testFile =
  "packages/auth/src/accounts/multi-account-affinity-failover.test.ts";
const requiredTests = [
  "keeps the replacement token and Codex organization in one credential receipt",
  "uses the current Codex reset when a rate-limit verdict waits for metadata ownership",
  "keeps concurrent usage when a health verdict waits for metadata ownership",
  "rechecks subscription extension before committing an expiry verdict",
  "keeps an email installed by another process during the metadata lock wait",
  "keeps an email that arrived while a profile backfill was pending",
  "does not count early subscription expiry as a usage refresh",
  "does not acknowledge usage when metadata fails before publication",
  "does not acknowledge usage when metadata fails after publication",
  "merges usage with a same-generation health verdict from another process",
  "refuses stale explicit usage guards before HTTP and preserves omitted-guard callers",
  "keeps a replacement healthy after old coding-bridge credential verification",
  "mid-session rate-limit failover preserves session semantics re-pins a pinned session to the sibling after its account rate-limits (respawn path: no exclude)",
  "mid-session rate-limit failover preserves session semantics honors the resolver-style exclude failover (429 retry: exclude the just-failed account)",
  "mid-session rate-limit failover preserves session semantics re-selects after the affinity attempts window and re-pins (SESSION_AFFINITY_MAX_ATTEMPTS)",
  "pool exhaustion and recovery returns null + healthy:0 when every account is rate-limited with a future reset (the router's honest-failure gate)",
  "pool exhaustion and recovery readmits an account once its rate-limit window elapses (state persisted through the real overlay)",
  "account removed mid-session fails over a pinned session when its account is deleted (credential + pool metadata)",
  "needs-reauth eviction is affinity-proof never serves a pinned needs-reauth account; re-linking restores it to rotation",
  "does not probe or refresh a disabled subscription account",
  "refuses an old usage response after the account credential is replaced",
  "keeps a replacement healthy when an older keepalive refresh is rejected",
  "refreshes usage with the exact newly rotated credential receipt",
  "keeps a newer health verdict while applying current-generation usage",
  "refuses a stale default-pool metadata snapshot inside the storage lock",
  "keeps legacy unbranded pool writes and omitted generation guards compatible",
  "keeps credential receipts outside the public outcome wire shape",
  "fences stale rate-limited mutations while preserving legacy omission",
  "fences stale unknown rate limit mutations while preserving legacy omission",
  "fences stale needs reauth mutations while preserving legacy omission",
  "fences stale invalid mutations while preserving legacy omission",
  "fences stale healthy mutations while preserving legacy omission",
  "fences stale usage primed mutations while preserving legacy omission",
];
assert.equal(requiredTests.length, 33);
const directoryRoot = testOutputPath("quint-account-pool-health");
await mkdir(directoryRoot, { recursive: true });
const directory = await mkdtemp(path.join(directoryRoot, "run-"));
const reportPath = path.join(directory, "tests.json");
const run = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    "src/accounts/multi-account-affinity-failover.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    cwd: path.join(root, "packages/auth"),
    env: process.env,
    encoding: "utf8",
    timeout: 360_000,
    maxBuffer: 32 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
assert.equal(
  run.signal,
  null,
  `Pool health conformance terminated by ${run.signal}`,
);
assert.equal(
  run.status,
  0,
  `Pool health conformance failed. See ${directory}/tests.log`,
);
const tests = requireVitestConformance(
  JSON.parse(await readFile(reportPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const manifest = JSON.parse(
  await readFile(path.join(root, model.replace(".qnt", ".cases.json")), "utf8"),
);
const inputs = {};
for (const source of [
  model,
  model.replace(".qnt", ".cases.json"),
  ...manifest.sources,
  "packages/scripts/lib/vitest-conformance.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      inputs,
      tests,
      report: reportPath,
      limitations: [
        "Actual vendor adapters use loopback HTTP responses and private encrypted files. No real vendor account is contacted.",
        "Named scenario conformance covers observable boundaries and controlled races, not every internal schedule in the finite model.",
        "Unbranded injected pools retain legacy omitted-guard behavior. AccountPoolBroker models broker leases separately. Timer ownership remains outside both models.",
      ],
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Account-pool health conformance passed all ${tests.length} required HTTP/filesystem/process cases. Evidence ${directory}`,
);
