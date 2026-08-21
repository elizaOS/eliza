import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevOwnedCodeAgentCommand } from "./dev-owned-code-agent.mjs";

test("uses an explicit ElizaOS ACP command unchanged", () => {
  assert.equal(
    resolveDevOwnedCodeAgentCommand({
      cwd: "/repo",
      configuredCommand: "custom-acp --safe",
      exists: () => true,
    }),
    "custom-acp --safe",
  );
});

test("resolves the built first-party ACP adapter in an Eliza source checkout", () => {
  const expected = "/repo/packages/examples/code/dist/acp.js";
  assert.equal(
    resolveDevOwnedCodeAgentCommand({
      cwd: "/repo",
      bunCommand: "/opt tools/bun",
      exists: (candidate) => candidate === expected,
    }),
    '"/opt tools/bun" "/repo/packages/examples/code/dist/acp.js"',
  );
});

test("does not invent an adapter when the first-party build is absent", () => {
  assert.equal(
    resolveDevOwnedCodeAgentCommand({
      cwd: "/repo",
      exists: () => false,
    }),
    undefined,
  );
});
