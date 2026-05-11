import { homedir } from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxService } from "./sandbox-service.js";

const ENV_KEYS = [
  "CODING_TOOLS_BLOCKED_PATHS",
  "CODING_TOOLS_BLOCKED_PATHS_ADD",
  "CODING_TOOLS_WORKSPACE_ROOTS",
  "ELIZA_PLATFORM",
  "ANDROID_ROOT",
  "ANDROID_DATA",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function mockRuntime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: (key: string) => settings[key],
    getService: () => null,
  } as IAgentRuntime;
}

describe("SandboxService default blocklist", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("always blocks user-home credential dirs", async () => {
    const svc = await SandboxService.start(mockRuntime());
    const blocked = svc.getBlockedPaths();
    const home = homedir();
    for (const sub of [
      ".ssh",
      ".aws",
      ".gnupg",
      ".docker",
      ".kube",
      ".netrc",
    ]) {
      const expected = path.join(home, sub);
      expect(
        blocked.some(
          (b) =>
            b === expected || b.startsWith(expected) || expected.startsWith(b),
        ),
        `${expected} should appear (or its realpath) in default blocklist`,
      ).toBe(true);
    }
    expect(blocked.some((b) => b.endsWith(path.join("/", "pvt")))).toBe(true);
    expect(blocked.some((b) => b.endsWith(path.join("/", "Library")))).toBe(
      true,
    );
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
      const v = await svc.validatePath(
        undefined,
        "/System/Library/Frameworks/foo",
      );
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
      expect(blocked.some((b) => path.resolve(b) === path.resolve(pf))).toBe(
        true,
      );
      expect(blocked.some((b) => path.resolve(b) === path.resolve(pd))).toBe(
        true,
      );
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

  it("reads coding-tools config from process.env when runtime settings omit it", async () => {
    const previous = process.env.CODING_TOOLS_BLOCKED_PATHS;
    try {
      process.env.CODING_TOOLS_BLOCKED_PATHS = "/tmp/env-only-block";
      const svc = await SandboxService.start(mockRuntime());
      expect(svc.getBlockedPaths()).toEqual(
        expect.arrayContaining([expect.stringMatching(/env-only-block$/)]),
      );
    } finally {
      if (previous === undefined) delete process.env.CODING_TOOLS_BLOCKED_PATHS;
      else process.env.CODING_TOOLS_BLOCKED_PATHS = previous;
    }
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

  it("limits access to configured CODING_TOOLS_WORKSPACE_ROOTS", async () => {
    const root = path.join(homedir(), "coding-tools-root");
    const svc = await SandboxService.start(
      mockRuntime({ CODING_TOOLS_WORKSPACE_ROOTS: root }),
    );
    expect(svc.getAllowedRoots()).toContain(root);

    const inside = await svc.validatePath(
      undefined,
      path.join(root, "file.ts"),
    );
    expect(inside.ok).toBe(true);

    const outside = await svc.validatePath(
      undefined,
      path.join(homedir(), "outside-root", "file.ts"),
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe("outside_allowed_roots");
  });

  it("supports conversation-scoped allow roots", async () => {
    const root = path.join(homedir(), "conversation-root");
    const svc = await SandboxService.start(mockRuntime());
    svc.addRoot("conversation-1", root);

    const inside = await svc.validatePath(
      "conversation-1",
      path.join(root, "nested", "file.ts"),
    );
    expect(inside.ok).toBe(true);
    expect(svc.getAllowedRoots("conversation-1")).toContain(root);

    svc.removeRoot("conversation-1", root);
    expect(svc.getAllowedRoots("conversation-1")).not.toContain(root);
  });

  it("adds Android system roots to the default blocklist on AOSP/mobile Android", async () => {
    const previous = process.env.ELIZA_PLATFORM;
    try {
      process.env.ELIZA_PLATFORM = "android";
      const svc = await SandboxService.start(mockRuntime());
      const blocked = svc.getBlockedPaths();
      expect(blocked).toEqual(expect.arrayContaining(["/vendor", "/apex"]));
      expect(blocked.some((p) => p.toLowerCase() === "/system")).toBe(true);
      const v = await svc.validatePath(undefined, "/vendor/bin/sh");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("blocked");
    } finally {
      if (previous === undefined) delete process.env.ELIZA_PLATFORM;
      else process.env.ELIZA_PLATFORM = previous;
    }
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
