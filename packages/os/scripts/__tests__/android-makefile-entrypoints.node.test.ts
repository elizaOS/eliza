import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const makefile = fileURLToPath(
  new URL("../../android/Makefile", import.meta.url),
);

test("Android bundle target passes the resolved Eliza checkout to its producer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "android-make-"));
  try {
    const callsFile = path.join(directory, "calls.jsonl");
    const sourceRoot = path.join(directory, "selected checkout");
    const overrides = path.join(directory, "dependencies.mk");
    const stagesFile = path.join(directory, "stages");
    // Run the real bundle recipe with isolated no-op build prerequisites.
    await writeFile(
      overrides,
      'preflight-grizzly prepare-grizzly native-inference-grizzly bootanimation splash:\n\t@echo stage >> "$(FIXTURE_STAGES)"\n',
    );
    await writeFile(
      path.join(directory, "node"),
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2].endsWith("/eliza-source.ts")) {
  console.log(process.env.FIXTURE_SOURCE);
} else {
  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({
    script: process.argv[2], source: process.env.ELIZAOS_ELIZA_ROOT
  }) + "\\n");
}
`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SOURCE_DATE_EPOCH: "1700000000",
      FIXTURE_SOURCE: sourceRoot,
      FIXTURE_CALLS: callsFile,
      FIXTURE_STAGES: stagesFile,
    };
    delete env.ELIZAOS_ELIZA_ROOT;
    delete env.MAKEFLAGS;
    const result = spawnSync(
      "make",
      [
        "-f",
        makefile,
        "-f",
        overrides,
        "bundle-grizzly",
        `BUNDLE_DIR=${directory}/bundle`,
      ],
      { cwd: directory, env, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      calls.map((call) => path.basename(call.script)),
      ["build-aosp.ts", "build-grizzly-bundle.ts"],
    );
    for (const call of calls)
      assert.equal(call.source, sourceRoot, call.script);
    await rm(callsFile);
    await rm(stagesFile);
    for (const [bundle, epoch, diagnostic] of [
      ["", "1700000000", "BUNDLE_DIR is required"],
      ["bundle", "", "SOURCE_DATE_EPOCH is required"],
    ]) {
      const invalid = spawnSync(
        "make",
        [
          "-j4",
          "-f",
          makefile,
          "-f",
          overrides,
          "bundle-grizzly",
          `BUNDLE_DIR=${bundle}`,
        ],
        {
          cwd: directory,
          env: { ...env, SOURCE_DATE_EPOCH: epoch },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.notEqual(invalid.status, 0);
      assert.ok(invalid.stderr.includes(diagnostic), invalid.stderr);
      await assert.rejects(readFile(callsFile), { code: "ENOENT" });
      await assert.rejects(readFile(stagesFile), { code: "ENOENT" });
    }
    await writeFile(
      overrides,
      'preflight-grizzly:\n\t@exit 17\nprepare-grizzly native-inference-grizzly bootanimation splash:\n\t@echo stage >> "$(FIXTURE_STAGES)"\n',
    );
    const failedPreflight = spawnSync(
      "make",
      [
        "-j4",
        "-k",
        "-f",
        makefile,
        "-f",
        overrides,
        "bundle-grizzly",
        `BUNDLE_DIR=${directory}/bundle`,
      ],
      { cwd: directory, env, encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(failedPreflight.status, 0, failedPreflight.stderr);
    await assert.rejects(readFile(callsFile), { code: "ENOENT" });
    await assert.rejects(readFile(stagesFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
