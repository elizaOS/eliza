import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const packaging = join(repositoryRoot, "linux/packaging/debian");
const validatorName = "validate-user-units";
const canVerify =
  process.platform === "linux" && existsSync("/usr/bin/systemd-analyze");

function runValidator(directory) {
  return spawnSync(join(directory, validatorName), [], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("Debian user-unit validation accepts the shipped graph and rejects unknown directives", {
  skip: !canVerify,
}, () => {
  const valid = runValidator(packaging);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const temporary = mkdtempSync(join(tmpdir(), "elizaos-debian-units-test-"));
  const fixture = join(temporary, "debian");
  try {
    cpSync(packaging, fixture, { recursive: true });
    appendFileSync(
      join(fixture, "elizaos-agent.service"),
      "\n[Service]\nNotARealSystemdDirective=yes\n",
    );
    const invalid = runValidator(fixture);
    assert.notEqual(invalid.status, 0);
    assert.match(
      `${invalid.stdout}\n${invalid.stderr}`,
      /Unknown (?:key|lvalue).*NotARealSystemdDirective/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Debian user-unit validation rejects an unavailable packaged command", {
  skip: !canVerify,
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "elizaos-debian-units-test-"));
  const fixture = join(temporary, "debian");
  try {
    cpSync(packaging, fixture, { recursive: true });
    const service = join(fixture, "elizaos-desktop.service");
    writeFileSync(
      service,
      readFileSync(service, "utf8").replace(
        "ExecStart=/usr/bin/eliza-desktop",
        "ExecStart=/usr/bin/missing-eliza-desktop",
      ),
    );
    const invalid = runValidator(fixture);
    assert.notEqual(invalid.status, 0);
    assert.match(
      `${invalid.stdout}\n${invalid.stderr}`,
      /missing-eliza-desktop.*(?:not executable|No such file)/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
