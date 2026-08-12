/** Exercises run node runtime behavior with deterministic app-core test fixtures. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  chooseElizaRuntime,
  findProbeMarkers,
  parseNodeMajor,
  probeEnv,
  probeNodeExecutable,
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

  test("accepts Node 24 markers when stdout includes preload banners or trailing chatter", () => {
    expect(
      validateNodeProbeOutput(
        "[apm-bootstrap] instrumenting process\nnode:24.4.0",
      ),
    ).toEqual({ ok: true, reason: null });
    expect(
      validateNodeProbeOutput("node:24.4.0\n[apm-bootstrap] done"),
    ).toEqual({ ok: true, reason: null });
    expect(
      validateNodeProbeOutput("(node:123) DeprecationWarning: x\nnode:24.4.0"),
    ).toEqual({ ok: true, reason: null });
  });

  test("reports the version reason for an old Node behind noisy probe stdout", () => {
    const result = validateNodeProbeOutput(
      "[apm-bootstrap] instrumenting process\nnode:22.23.0",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Node.js 22.23.0 is too old");
    expect(result.reason).not.toContain("did not report a Node.js runtime");
  });

  test("rejects bun when preceded by shim or preload output", () => {
    expect(validateNodeProbeOutput("[nvm-shim] loading\nbun")).toEqual({
      ok: false,
      reason: "resolved to Bun, not Node.js",
    });
  });

  test("rejects disagreeing node: markers as ambiguous rather than picking one", () => {
    const result = validateNodeProbeOutput("node:24.4.0\nnode:22.23.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(
      /reported more than one Node\.js runtime \(24\.4\.0, 22\.23\.0\)/,
    );
  });

  test("accepts repeated identical node: markers", () => {
    expect(validateNodeProbeOutput("node:24.4.0\nnode:24.4.0")).toEqual({
      ok: true,
      reason: null,
    });
  });

  test("still rejects junk-only probe output with no marker", () => {
    expect(validateNodeProbeOutput("[apm-bootstrap] only noise")).toEqual({
      ok: false,
      reason: "did not report a Node.js runtime",
    });
  });

  test("strips NODE_OPTIONS from probeEnv without removing PATH", () => {
    const env = probeEnv({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--require ./apm-bootstrap.js",
      HOME: "/home/eliza",
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/eliza");
  });

  test("strips NODE_OPTIONS from the real probe child", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "eliza-node-probe-"));
    const preloadPath = path.join(tempDir, "stdout-preload.mjs");
    writeFileSync(
      preloadPath,
      'process.stdout.write("unexpected preload banner");\n',
    );

    try {
      const result = probeNodeExecutable(process.execPath, {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      });
      expect(result).toMatchObject({
        status: 0,
        stdout: `node:${process.versions.node}`,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const testPosix = process.platform === "win32" ? test.skip : test;
  testPosix(
    "isolates the marker from a PATH shim banner without a newline",
    () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "eliza-node-shim-"));
      const shimPath = path.join(tempDir, "node-shim.cjs");
      writeFileSync(
        shimPath,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
process.stdout.write("[shim-without-newline]");
const child = spawnSync(process.execPath, process.argv.slice(2), {
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(child.stdout ?? "");
process.stderr.write(child.stderr ?? "");
process.exit(child.status ?? 1);
`,
      );
      chmodSync(shimPath, 0o755);

      try {
        expect(probeNodeExecutable(shimPath)).toMatchObject({
          status: 0,
          stdout: `[shim-without-newline]\nnode:${process.versions.node}`,
        });
        expect(
          validateNodeExecutable({
            candidate: shimPath,
            platform: process.platform,
          }),
        ).toEqual({ ok: true, reason: null });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test("findProbeMarkers collects exact line markers only", () => {
    expect(
      findProbeMarkers(
        "[apm-bootstrap] instrumenting process\nnode:24.4.0\nbun\n",
      ),
    ).toEqual({
      sawBun: true,
      nodeVersions: ["24.4.0"],
    });
    expect(findProbeMarkers("(node:123) DeprecationWarning: x")).toEqual({
      sawBun: false,
      nodeVersions: [],
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
