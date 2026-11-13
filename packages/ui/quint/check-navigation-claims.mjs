/** Require every named source-protocol and assembled selection callback check. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const suites = {
  ConversationMessageLoad: {
    test: "src/state/__e2e__/conversation-message-load.test.tsx",
    names: [
      "conversation message load ownership clears old transcript rows before a new owner's request",
      "conversation message load ownership ignores a transport success after another owner claims the view",
      "conversation message load ownership keeps a newer same-owner response when an older request finishes",
      "conversation message load ownership fences a missing-thread list response after a new owner claim",
      "conversation message load ownership returns the loader's fallback ownership after a missing-thread reply",
      "conversation message load ownership preserves a cached transcript after transient revalidation failure",
      "conversation message load ownership fences a centered window superseded by a newest-history request",
      "conversation message load ownership does not publish an around window after its callback changes ownership",
    ],
  },
  NavigateViewClaims: {
    test: "src/events/__e2e__/navigate-view-claims.test.ts",
    names: [
      "navigation request claims retains distinct cold requests and applies them in FIFO order",
      "navigation request claims does not let a later request overtake an applying request",
      "navigation request claims keeps identical payloads as distinct request identities",
      "navigation request claims allows another listener to claim after a synchronous refusal or throw",
      "navigation request claims retries a declined head after a new dispatch resets the decline epoch",
      "navigation request claims rejects only an applying live request and resolves it once",
      "navigation request claims drops the oldest request at the exact sixteen-item bound",
      "navigation request claims keeps a replacement blocked until the retired promise settles",
      "navigation request claims repeats a pre-completion effect after its retired promise resolves true",
      "navigation request claims allows reentrant delivery before the first callback publishes applying",
    ],
  },
  ConversationSelection: {
    test: "src/state/__e2e__/conversation-selection.test.tsx",
    names: [
      "conversation selection callback persists the leaving draft and selects the target before its load settles",
      "conversation selection callback retains late rollback after its calling surface retires",
      "conversation selection callback keeps the newer selection when an older load fails",
      "conversation selection callback fences an old missing-target list after another selection",
      "conversation selection callback clears the selection when the missing-target list has no fallback",
      "conversation selection callback removes an owned empty draft before leaving it",
      "conversation selection callback uses the actual stored draft when saving the edit fails",
      "conversation selection callback advances the epoch without reloading an already visible conversation",
    ],
  },
};
const selected = process.argv[2]
  ? [path.basename(process.argv[2], ".qnt")]
  : Object.keys(suites);
const outputRoot = testOutputPath("quint-navigation-claims");
mkdirSync(outputRoot, { recursive: true });
for (const name of selected) {
  const suite = suites[name];
  assert(suite, `Unknown navigation model ${name}`);
  if (process.argv[2]) {
    assert.equal(
      path.resolve(process.argv[2]),
      path.join(root, "packages/ui/quint", `${name}.qnt`),
    );
  }
  const output = mkdtempSync(path.join(outputRoot, `${name}-conformance-`));
  const report = path.join(output, "vitest.json");
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      "--config",
      "vitest.config.ts",
      "--no-file-parallelism",
      suite.test,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, "packages/ui"),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
      },
    },
  );
  writeFileSync(
    path.join(output, "output.log"),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const checks = requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(root, "packages/ui", suite.test),
    suite.names,
  );
  writeFileSync(
    path.join(output, "checked.json"),
    `${JSON.stringify(checks, null, 2)}\n`,
  );
  console.log(
    `${name} conformance passed ${checks.length} named source checks`,
  );
}
