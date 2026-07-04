/** Exercises run node runtime behavior with deterministic app-core test fixtures. */
import { describe, expect, test } from "vitest";
import {
  chooseElizaRuntime,
  parseNodeMajor,
  resolveNodeExecPath,
  resolveNodeExecPathFromCandidates,
  validateNodeExecutable,
  validateNodeProbeOutput,
} from "./run-node-runtime.mjs";

const probe = (outputs) => (candidate) =>
  outputs[candidate] ?? {
    status: 1,
    stdout: "",
    stderr: "missing",
  };

describe("run-node-runtime node validation", () => {
  test("defaults to Bun when both runtimes are available", () => {
    expect(
      chooseElizaRuntime({
        platform: "darwin",
        hasBun: true,
        hasNode: true,
      }),
    ).toEqual({ runtime: "bun", warning: null });
  });

  test("defaults to Node when Bun is unavailable", () => {
    expect(
      chooseElizaRuntime({
        platform: "darwin",
        hasBun: false,
        hasNode: true,
      }),
    ).toEqual({ runtime: "node", warning: null });
  });

  test("keeps Bun-only installs on Bun without requiring Node", () => {
    expect(
      chooseElizaRuntime({
        platform: "darwin",
        hasBun: true,
        hasNode: false,
      }),
    ).toEqual({ runtime: "bun", warning: null });
  });

  test("honors explicit runtime overrides", () => {
    expect(
      chooseElizaRuntime({
        requestedRuntime: "node",
        platform: "darwin",
        hasBun: true,
        hasNode: true,
      }),
    ).toEqual({ runtime: "node", warning: null });
    expect(
      chooseElizaRuntime({
        requestedRuntime: "bun",
        platform: "darwin",
        hasBun: true,
        hasNode: true,
      }),
    ).toEqual({ runtime: "bun", warning: null });
  });

  test("falls back from unstable Bun 1.3.9 on Linux only when Node is available", () => {
    const withNode = chooseElizaRuntime({
      platform: "linux",
      bunVersion: "1.3.9",
      hasBun: true,
      hasNode: true,
    });
    expect(withNode.runtime).toBe("node");
    expect(withNode.warning).toContain("Bun 1.3.9");

    expect(
      chooseElizaRuntime({
        platform: "linux",
        bunVersion: "1.3.9",
        hasBun: true,
        hasNode: false,
      }),
    ).toEqual({ runtime: "bun", warning: null });
  });

  test("parses Node major versions", () => {
    expect(parseNodeMajor("24.1.0")).toBe(24);
    expect(parseNodeMajor("25")).toBe(25);
    expect(parseNodeMajor("v24.1.0")).toBeNull();
  });

  test("rejects Bun probe output", () => {
    expect(validateNodeProbeOutput("bun")).toEqual({
      ok: false,
      reason: "resolved to Bun, not Node.js",
    });
  });

  test("rejects Node versions below the repo requirement", () => {
    const result = validateNodeProbeOutput("node:23.9.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Node.js 24+ is required");
  });

  test("accepts Node 24 and newer", () => {
    expect(validateNodeProbeOutput("node:24.0.0")).toEqual({
      ok: true,
      reason: null,
    });
    expect(validateNodeProbeOutput("node:25.1.0")).toEqual({
      ok: true,
      reason: null,
    });
  });

  test("rejects Codex-bundled macOS Node", () => {
    const result = validateNodeExecutable({
      candidate: "/Applications/Codex.app/Contents/Resources/node",
      platform: "darwin",
      probeNode: probe({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Codex-bundled");
  });

  test("throws for an invalid explicit ELIZA_NODE_PATH", () => {
    expect(() =>
      resolveNodeExecPath({
        currentExecPath: "/valid/node",
        explicitNodePath: "/bad/bun",
        platform: "darwin",
        probeNode: probe({
          "/bad/bun": { status: 0, stdout: "bun", stderr: "" },
          "/valid/node": { status: 0, stdout: "node:24.0.0", stderr: "" },
        }),
      }),
    ).toThrow(/Invalid ELIZA_NODE_PATH=\/bad\/bun/);
  });

  test("skips invalid candidates and returns a valid Node", () => {
    expect(
      resolveNodeExecPathFromCandidates({
        candidates: ["/old/node", "/bun", "/good/node"],
        platform: "linux",
        probeNode: probe({
          "/old/node": { status: 0, stdout: "node:22.12.0", stderr: "" },
          "/bun": { status: 0, stdout: "bun", stderr: "" },
          "/good/node": { status: 0, stdout: "node:24.2.0", stderr: "" },
        }),
      }),
    ).toBe("/good/node");
  });

  test("falls back from a Bun current executable to node command when valid", () => {
    expect(
      resolveNodeExecPath({
        currentExecPath: "/usr/local/bin/bun",
        platform: "linux",
        probeNode: probe({
          node: { status: 0, stdout: "node:24.0.0", stderr: "" },
        }),
      }),
    ).toBe("node");
  });
});
