import { homedir } from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SandboxService } from "./sandbox-service.js";

function mockRuntime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: (key: string) => settings[key],
    getService: () => null,
  } as unknown as IAgentRuntime;
}

describe("SandboxService default blocklist", () => {
  it("always blocks user-home credential dirs", async () => {
    const svc = await SandboxService.start(mockRuntime());
    const blocked = svc.getBlockedPaths();
    const home = homedir();
    for (const sub of [".ssh", ".aws", ".gnupg", ".docker", ".kube", ".netrc"]) {
      const expected = path.join(home, sub);
      expect(
        blocked.some(
          (b) => b === expected || b.startsWith(expected) || expected.startsWith(b),
        ),
        `${expected} should appear (or its realpath) in default blocklist`,
      ).toBe(true);
    }
    expect(blocked.some((b) => b.endsWith(path.join("/", "pvt")))).toBe(true);
    expect(blocked.some((b) => b.endsWith(path.join("/", "Library")))).toBe(true);
  });

  if (process.platform === "darwin") {
    it("(darwin) blocks /System and /usr/bin by default", async () => {
      const svc = await SandboxService.start(mockRuntime());
      const blocked = svc.getBlockedPaths();
      expect(blocked).toContain("/System");
      expect(blocked).toContain("/usr/bin");
      expect(blocked).toContain("/usr/sbin");
      expect(blocked).toContain("/Library/LaunchDaemons");
    });

    it("(darwin) /etc realpath-resolves to /private/etc and blocks reads under it", async () => {
      const svc = await SandboxService.start(mockRuntime());
      const v = await svc.validatePath(undefined, "/etc/hosts");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("blocked");
    });

    it("(darwin) blocks paths under /System", async () => {
      const svc = await SandboxService.start(mockRuntime());
      const v = await svc.validatePath(undefined, "/System/Library/Frameworks/foo");
      expect(v.ok).toBe(false);
    });
  }

  if (process.platform === "linux") {
    it("(linux) blocks /etc, /boot, /sys, /root by default", async () => {
      const svc = await SandboxService.start(mockRuntime());
      const blocked = svc.getBlockedPaths();
      expect(blocked).toContain("/etc");
      expect(blocked).toContain("/boot");
      expect(blocked).toContain("/sys");
      expect(blocked).toContain("/root");
      expect(blocked).toContain("/usr/bin");
    });
  }

  if (process.platform === "win32") {
    it("(win32) blocks %SystemRoot%, %ProgramFiles%, %ProgramData% by default", async () => {
      const svc = await SandboxService.start(mockRuntime());
      const blocked = svc.getBlockedPaths();
      const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
      const pf = process.env.ProgramFiles ?? "C:\\Program Files";
      const pd = process.env.ProgramData ?? "C:\\ProgramData";
      expect(
        blocked.some((b) => path.resolve(b) === path.resolve(sysRoot)),
      ).toBe(true);
      expect(
        blocked.some((b) => path.resolve(b) === path.resolve(pf)),
      ).toBe(true);
      expect(
        blocked.some((b) => path.resolve(b) === path.resolve(pd)),
      ).toBe(true);
    });
  }

  it("CODING_TOOLS_BLOCKED_PATHS replaces the default list", async () => {
    const svc = await SandboxService.start(
      mockRuntime({ CODING_TOOLS_BLOCKED_PATHS: "/tmp/only-this" }),
    );
    const blocked = svc.getBlockedPaths();
    expect(blocked.length).toBe(1);
    expect(blocked[0]).toMatch(/only-this$/);
  });

  it("CODING_TOOLS_BLOCKED_PATHS_ADD extends the default list", async () => {
    const svc = await SandboxService.start(
      mockRuntime({ CODING_TOOLS_BLOCKED_PATHS_ADD: "/tmp/extra-block" }),
    );
    const blocked = svc.getBlockedPaths();
    expect(blocked.some((b) => b.endsWith("extra-block"))).toBe(true);
    // Defaults still present.
    expect(blocked.some((b) => b.endsWith(path.join(".ssh")))).toBe(true);
  });

  it("expands ~ and $HOME in configured paths", async () => {
    const svc = await SandboxService.start(
      mockRuntime({
        CODING_TOOLS_BLOCKED_PATHS: "~/blocked-tilde,$HOME/blocked-home",
      }),
    );
    const blocked = svc.getBlockedPaths();
    const home = homedir();
    expect(blocked).toContain(path.join(home, "blocked-tilde"));
    expect(blocked).toContain(path.join(home, "blocked-home"));
  });

  it("rejects relative paths regardless of blocklist", async () => {
    const svc = await SandboxService.start(mockRuntime());
    const v = await svc.validatePath(undefined, "relative/path");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_absolute");
  });

  it("permits paths outside the blocklist", async () => {
    const svc = await SandboxService.start(mockRuntime());
    const v = await svc.validatePath(
      undefined,
      path.join(homedir(), "totally-fine-dir"),
    );
    expect(v.ok).toBe(true);
  });
});
