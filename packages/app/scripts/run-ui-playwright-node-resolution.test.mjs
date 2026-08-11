/**
 * Exercises the Playwright-lane Node runtime resolution shared by
 * scripts/run-ui-playwright.mjs and the playwright.*.config.ts webServer
 * commands. Deterministic: candidate probes are injected fixtures mirroring
 * app-core's run-node-runtime.test.mjs, plus one real-probe acceptance case
 * against the host runtime when it is a genuine Node.js 24+ process.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNodeMajor } from "../../app-core/scripts/run-node-runtime.mjs";
import {
  resolveExecutableFromPath,
  resolvePlaywrightNodeRuntime,
} from "./lib/playwright-node-runtime.mjs";

const probe = (outputs) => (candidate) =>
  outputs[candidate] ?? {
    status: 1,
    stdout: "",
    stderr: "missing",
  };

describe("playwright node runtime resolution", () => {
  it("throws the exact contract for an invalid explicit ELIZA_NODE_PATH", () => {
    assert.throws(
      () =>
        resolvePlaywrightNodeRuntime({
          env: { ELIZA_NODE_PATH: "/bad/node" },
          platform: "darwin",
          execPath: "/valid/node",
          probeNode: probe({
            "/valid/node": { status: 0, stdout: "node:24.0.0", stderr: "" },
          }),
        }),
      /^Error: Invalid ELIZA_NODE_PATH=\/bad\/node: .*\. Set ELIZA_NODE_PATH to a standard Node\.js 24\+ executable\.$/,
    );
  });

  it("rejects an explicit ELIZA_NODE_PATH that resolves to Bun", () => {
    assert.throws(
      () =>
        resolvePlaywrightNodeRuntime({
          env: { ELIZA_NODE_PATH: "/opt/bun/bin/bun" },
          platform: "linux",
          execPath: "/valid/node",
          probeNode: probe({
            "/opt/bun/bin/bun": { status: 0, stdout: "bun", stderr: "" },
            "/valid/node": { status: 0, stdout: "node:24.0.0", stderr: "" },
          }),
        }),
      /Invalid ELIZA_NODE_PATH=\/opt\/bun\/bin\/bun: resolved to Bun, not Node\.js/,
    );
  });

  it("rejects an explicit ELIZA_NODE_PATH below the Node 24 requirement", () => {
    assert.throws(
      () =>
        resolvePlaywrightNodeRuntime({
          env: { ELIZA_NODE_PATH: "/old/node" },
          platform: "linux",
          execPath: "/valid/node",
          probeNode: probe({
            "/old/node": { status: 0, stdout: "node:22.23.0", stderr: "" },
            "/valid/node": { status: 0, stdout: "node:24.0.0", stderr: "" },
          }),
        }),
      /Invalid ELIZA_NODE_PATH=\/old\/node: Node\.js 22\.23\.0 is too old; Node\.js 24\+ is required/,
    );
  });

  it("accepts a valid explicit ELIZA_NODE_PATH and returns it unchanged", () => {
    assert.equal(
      resolvePlaywrightNodeRuntime({
        env: { ELIZA_NODE_PATH: " /explicit/node " },
        platform: "darwin",
        execPath: "/other/node",
        probeNode: probe({
          "/explicit/node": { status: 0, stdout: "node:24.3.0", stderr: "" },
        }),
      }),
      "/explicit/node",
    );
  });

  it("prefers npm_node_execpath when no explicit path is set", () => {
    assert.equal(
      resolvePlaywrightNodeRuntime({
        env: { npm_node_execpath: "/npm/node", PATH: "" },
        platform: "linux",
        execPath: "/exec/node",
        probeNode: probe({
          "/npm/node": { status: 0, stdout: "node:24.1.0", stderr: "" },
          "/exec/node": { status: 0, stdout: "node:24.1.0", stderr: "" },
        }),
      }),
      "/npm/node",
    );
  });

  it("skips a Bun process.execPath and a pre-24 npm_node_execpath, landing on PATH node", () => {
    assert.equal(
      resolvePlaywrightNodeRuntime({
        env: { npm_node_execpath: "/old/node", PATH: "" },
        platform: "linux",
        execPath: "/usr/local/bin/bun",
        probeNode: probe({
          "/old/node": { status: 0, stdout: "node:22.12.0", stderr: "" },
          "/usr/local/bin/bun": { status: 0, stdout: "bun", stderr: "" },
          node: { status: 0, stdout: "node:24.2.0", stderr: "" },
        }),
      }),
      "node",
    );
  });

  it("throws the no-usable-node contract when every candidate fails", () => {
    assert.throws(
      () =>
        resolvePlaywrightNodeRuntime({
          env: { npm_node_execpath: "/old/node", PATH: "" },
          platform: "linux",
          execPath: "/usr/local/bin/bun",
          probeNode: probe({
            "/old/node": { status: 0, stdout: "node:22.12.0", stderr: "" },
            "/usr/local/bin/bun": { status: 0, stdout: "bun", stderr: "" },
          }),
        }),
      /No usable Node\.js 24\+ executable found .*Install Node\.js 24\+ or set ELIZA_NODE_PATH=\/absolute\/path\/to\/node\./,
    );
  });

  it("rejects the Codex-bundled macOS Node as an explicit path", () => {
    assert.throws(
      () =>
        resolvePlaywrightNodeRuntime({
          env: {
            ELIZA_NODE_PATH: "/Applications/Codex.app/Contents/Resources/node",
          },
          platform: "darwin",
          execPath: "/valid/node",
          probeNode: probe({
            "/Applications/Codex.app/Contents/Resources/node": {
              status: 0,
              stdout: "node:24.0.0",
              stderr: "",
            },
          }),
        }),
      /Invalid ELIZA_NODE_PATH=.*Codex-bundled macOS Node is not supported/,
    );
  });

  it("resolves executables from PATH and misses cleanly", () => {
    assert.equal(
      resolveExecutableFromPath("definitely-not-a-real-binary-xyz", {
        PATH: "/nonexistent-dir-for-test",
      }),
      null,
    );
    assert.equal(resolveExecutableFromPath("node", { PATH: "" }), null);
  });

  const hostIsNode24 =
    !process.versions.bun &&
    (parseNodeMajor(process.versions.node ?? "") ?? 0) >= 24;

  it("accepts the live host Node 24+ runtime via the real probe", {
    skip: !hostIsNode24,
  }, () => {
    assert.equal(
      resolvePlaywrightNodeRuntime({
        env: { ELIZA_NODE_PATH: process.execPath },
        platform: process.platform,
        execPath: process.execPath,
      }),
      process.execPath,
    );
  });
});
