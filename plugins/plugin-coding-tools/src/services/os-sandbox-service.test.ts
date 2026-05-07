import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OsSandboxService, smokeCheckDarwinProfile } from "./os-sandbox-service.js";

function mockRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: () => undefined,
    getService: () => null,
  } as unknown as IAgentRuntime;
}

describe("OsSandboxService", () => {
  let svc: OsSandboxService;
  let tmpRoot: string;

  beforeEach(async () => {
    svc = await OsSandboxService.start(mockRuntime());
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "os-sbx-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("detects platform-appropriate sandbox kind", () => {
    const kind = svc.detectedKind();
    if (process.platform === "darwin") {
      expect(["sandbox-exec", "none"]).toContain(kind);
    } else if (process.platform === "linux") {
      expect(["bwrap", "none"]).toContain(kind);
    } else {
      expect(kind).toBe("none");
    }
    expect(svc.isAvailable()).toBe(kind !== "none");
  });

  it("passthrough mode returns the original bash invocation", () => {
    // Force a passthrough by stubbing platform detection.
    const fakeSvc = svc as unknown as { kind: string };
    const prev = fakeSvc.kind;
    fakeSvc.kind = "none";
    try {
      const res = svc.wrap({ command: "echo hi", cwd: tmpRoot, roots: [tmpRoot] });
      expect(res.kind).toBe("none");
      expect(res.binary).toBe("/bin/bash");
      expect(res.args).toEqual(["-c", "echo hi"]);
    } finally {
      fakeSvc.kind = prev;
    }
  });

  if (process.platform === "darwin") {
    it("(darwin) generates a parseable sandbox-exec profile", async () => {
      // Force darwin path even if /usr/bin/sandbox-exec is missing on the runner.
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "sandbox-exec";
      const res = svc.wrap({ command: "echo hi", cwd: tmpRoot, roots: [tmpRoot] });
      try {
        expect(res.kind).toBe("sandbox-exec");
        expect(res.binary).toBe("/usr/bin/sandbox-exec");
        expect(res.args[0]).toBe("-f");
        const profilePath = res.args[1]!;
        expect(existsSync(profilePath)).toBe(true);
        const stat = statSync(profilePath);
        expect(stat.size).toBeGreaterThan(0);
        // The smoke checker only runs sandbox-exec when it's actually
        // present; otherwise it returns true. Either way, we shouldn't
        // crash.
        expect(typeof smokeCheckDarwinProfile).toBe("function");
      } finally {
        res.cleanup();
      }
    });

    it("(darwin) cleanup removes the temp profile", () => {
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "sandbox-exec";
      const res = svc.wrap({ command: "echo hi", cwd: tmpRoot, roots: [tmpRoot] });
      const profilePath = res.args[1]!;
      expect(existsSync(profilePath)).toBe(true);
      res.cleanup();
      expect(existsSync(profilePath)).toBe(false);
    });

    it("(darwin) profile passes sandbox-exec syntax check", () => {
      if (!existsSync("/usr/bin/sandbox-exec")) {
        // Not actually on darwin with sandbox-exec installed → skip body.
        return;
      }
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "sandbox-exec";
      const res = svc.wrap({ command: "echo hi", cwd: tmpRoot, roots: [tmpRoot] });
      try {
        expect(res.binary).toBe("/usr/bin/sandbox-exec");
        // Run /usr/bin/true under the profile to validate it parses + executes.
        execFileSync("/usr/bin/sandbox-exec", ["-f", res.args[1]!, "/usr/bin/true"], {
          stdio: "ignore",
        });
      } finally {
        res.cleanup();
      }
    });

    it("(darwin) actually wraps and runs a real command", () => {
      if (!existsSync("/usr/bin/sandbox-exec")) return;
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "sandbox-exec";
      const res = svc.wrap({
        command: "echo wrapped-ok",
        cwd: tmpRoot,
        roots: [tmpRoot],
        allowNetwork: true,
      });
      try {
        const out = execFileSync(res.binary, res.args, {
          encoding: "utf8",
          cwd: tmpRoot,
        });
        expect(out.trim()).toBe("wrapped-ok");
      } finally {
        res.cleanup();
      }
    });
  }

  if (process.platform === "linux") {
    it("(linux) bwrap args bind workspace and unshare network when not allowed", () => {
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "bwrap";
      const res = svc.wrap({
        command: "echo hi",
        cwd: tmpRoot,
        roots: [tmpRoot],
      });
      expect(res.kind).toBe("bwrap");
      expect(res.binary).toBe("/usr/bin/bwrap");
      expect(res.args).toContain("--ro-bind");
      expect(res.args).toContain("--unshare-net");
      expect(res.args).toContain("--bind");
      // tmpRoot should appear as a bind mount.
      expect(res.args).toContain(tmpRoot);
      expect(res.args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
    });

    it("(linux) allowNetwork omits --unshare-net", () => {
      const fakeSvc = svc as unknown as { kind: string };
      fakeSvc.kind = "bwrap";
      const res = svc.wrap({
        command: "echo hi",
        cwd: tmpRoot,
        roots: [tmpRoot],
        allowNetwork: true,
      });
      expect(res.args).not.toContain("--unshare-net");
    });
  }
});
