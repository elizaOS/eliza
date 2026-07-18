import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, evaluate } from "./security-advisory-gate.mjs";

describe("security advisory classification", () => {
  it("protects a sensitive previous_filename on rename", () => {
    const result = classify({
      files: [{
        filename: "packages/core/src/ordinary.ts",
        previous_filename: "packages/core/src/auth/token.ts",
      }],
    });
    assert.equal(result.protected, true);
  });

  it("protects security-sensitive mjs and cjs files", () => {
    assert.equal(classify({ files: ["scripts/security/check.mjs"] }).protected, true);
    assert.equal(classify({ files: ["scripts/auth/check.cjs"] }).protected, true);
  });

  it("does not treat the former exemption label as authorization", () => {
    const result = classify({
      labels: ["security-gate-exempt"],
      files: ["packages/core/src/auth/session.ts"],
    });
    assert.equal(result.protected, true);
  });
});

describe("security advisory outcomes", () => {
  it("requires both real successful job outcomes", () => {
    assert.equal(evaluate([{ name: "security", conclusion: "success" }]).passed, false);
    assert.equal(evaluate([
      { name: "security", conclusion: "success" },
      { name: "claude-review", conclusion: "skipped" },
    ]).passed, false);
    assert.equal(evaluate([
      { name: "security", conclusion: "success" },
      { name: "claude-review", conclusion: "success" },
    ]).passed, true);
  });
});
