/** Verifies the Linux bootstrap's immutable toolchain and no-sudo boundary. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./bootstrap-linux-dev.sh", import.meta.url),
);
const source = readFileSync(scriptPath, "utf8");

describe("Linux development bootstrap", () => {
  it("pins Bun and Node archives by version and SHA-256", () => {
    assert.match(source, /BUN_VERSION="1\.3\.14"/u);
    assert.match(source, /NODE_VERSION="24\.15\.0"/u);
    assert.match(source, /BUN_ARCHIVE_SHA256="[a-f0-9]{64}"/u);
    assert.match(source, /NODE_ARCHIVE_SHA256="[a-f0-9]{64}"/u);
    assert.match(source, /sha256sum --check --status/u);
    assert.match(source, /bun install --frozen-lockfile/u);
  });

  it("never elevates privileges and is valid Bash", () => {
    assert.doesNotMatch(source, /(^|[;&|]\s*)sudo\s/mu);
    const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  });

  it("documents its read/write boundary without bootstrapping", () => {
    const help = spawnSync("bash", [scriptPath, "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(
      help.stdout,
      /performs no\nprivilege escalation or system-package mutation/u,
    );
  });
});
