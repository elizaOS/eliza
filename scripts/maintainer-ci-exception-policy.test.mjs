/**
 * Protects the maintainer CI exception's fail-closed conditions across the
 * contributor guide, fleet rules, and pull request record template.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const readRepositoryFile = (path) =>
  readFileSync(join(repositoryRoot, path), "utf8").replace(/\s+/g, " ");

describe("maintainer CI exception policy", () => {
  const contributing = readRepositoryFile("CONTRIBUTING.md");
  const fleet = readRepositoryFile(".github/FLEET.md");
  const pullRequestTemplate = readRepositoryFile(
    ".github/pull_request_template.md",
  );

  it("limits the exception to exact-head, independently authorized evidence", () => {
    assert.match(contributing, /### Maintainer CI exception/);
    assert.match(contributing, /exact 40-character pull request head SHA/);
    assert.match(contributing, /explicitly named as a bypass actor/);
    assert.match(contributing, /write or administration access alone is not/);
    assert.match(contributing, /currently grants no bypass actors/);
    assert.match(
      contributing,
      /failure is proven unrelated to the pull request diff/,
    );
    assert.match(contributing, /exact-head results for all tests/);
    assert.match(contributing, /independent approving reviewer/);
    assert.match(
      contributing,
      /bypass authorization from a maintainer other than the pull request author/,
    );
  });

  it("invalidates changed heads and retains protected failure boundaries", () => {
    assert.match(
      contributing,
      /exception is invalid as soon as the pull request head or validated `origin\/develop` changes/,
    );
    assert.match(contributing, /never waives[\s\S]*unresolved conflicts/);
    assert.match(contributing, /failed affected tests/);
    assert.match(
      contributing,
      /security and secret scans[\s\S]*must complete successfully for the exact head/,
    );
    assert.match(
      contributing,
      /release\/build provenance and source-SHA attestations/,
    );
    assert.match(contributing, /pull request is no longer conflict-free/);
    assert.match(contributing, /validated `origin\/develop` changes/);
    assert.match(contributing, /second-lane rules[\s\S]*money, schema, deploy/);
    assert.match(
      contributing,
      /changes this exception may not rely on the new wording for its own merge/,
    );
  });

  it("requires a durable exception and rollback record", () => {
    for (const field of [
      "PR head SHA",
      "Validated `origin/develop` SHA",
      "Live ruleset readback and named bypass eligibility",
      "Queued or failing checks and run URLs",
      "Infrastructure-only or unrelated-failure proof",
      "Exact-head commands, exit status, and artifacts",
      "Exact-head security, secret-scan, and provenance results",
      "Conflict-free and affected-path failure attestation",
      "Independent approving reviewer",
      "Bypass authorizer",
      "Merge method",
      "Rollback owner",
      "Post-merge `develop` validation",
    ]) {
      assert.match(pullRequestTemplate, new RegExp(`- ${field}:`));
    }
    assert.match(fleet, /Maintainer CI exception/);
    assert.match(fleet, /reviewer and bypass authorizer remain separate/);
    assert.match(fleet, /policy itself never creates authority/);
    assert.match(
      contributing,
      /Immediately before merging[\s\S]*re-read the remote head/,
    );
    assert.match(contributing, /immediate revert or repair/);
    assert.match(
      contributing,
      /does not change GitHub rulesets or grant bypass/,
    );
  });
});
