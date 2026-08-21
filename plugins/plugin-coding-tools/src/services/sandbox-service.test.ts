/** Tests for the SandboxService path policy: blocklist defaults and allow-root enforcement. */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
      // `loadConfig()` realpath-normalises every blocklist entry, which on
      // Windows returns the canonical on-disk casing (`C:\Windows`),
      // whereas `process.env.SystemRoot` is whatever case the environment
      // exposes (`C:\WINDOWS`). NTFS is case-insensitive — compare lowered.
      const samePath = (a: string, b: string): boolean =>
        path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      expect(blocked.some((b) => samePath(b, sysRoot))).toBe(true);
      expect(blocked.some((b) => samePath(b, pf))).toBe(true);
      expect(blocked.some((b) => samePath(b, pd))).toBe(true);
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

  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("rejects device files directly and through a symlink", async () => {
    const rawRoot = mkdtempSync(path.join(tmpdir(), "eliza-sandbox-device-"));
    try {
      const root = realpathSync(rawRoot);
      const alias = path.join(root, "random-device");
      symlinkSync("/dev/urandom", alias, "file");
      const svc = await SandboxService.start(
        mockRuntime({ CODING_TOOLS_BLOCKED_PATHS: path.join(root, "unused") }),
      );

      const stdinAlias = path.join(root, "stdin-device");
      symlinkSync("/dev/stdin", stdinAlias, "file");
      const chainedAlias = path.join(root, "chained-stdin-device");
      symlinkSync(stdinAlias, chainedAlias, "file");

      for (const candidate of [
        "/dev/urandom",
        alias,
        "/dev/stdin",
        "/dev/fd/0",
        stdinAlias,
        chainedAlias,
      ]) {
        const result = await svc.validatePath(undefined, candidate);
        expect(result.ok, candidate).toBe(false);
        if (!result.ok) expect(result.reason).toBe("blocked");
      }
    } finally {
      rmSync(rawRoot, { recursive: true, force: true });
    }
  });

  itPosix("does not throw while canonicalizing a cyclic symlink", async () => {
    const rawRoot = mkdtempSync(path.join(tmpdir(), "eliza-sandbox-loop-"));
    try {
      const root = realpathSync(rawRoot);
      const loop = path.join(root, "loop");
      symlinkSync("loop", loop, "file");
      const svc = await SandboxService.start(
        mockRuntime({ CODING_TOOLS_BLOCKED_PATHS: path.join(root, "unused") }),
      );

      await expect(svc.validatePath(undefined, loop)).resolves.toEqual({
        ok: true,
        resolved: loop,
      });
    } finally {
      rmSync(rawRoot, { recursive: true, force: true });
    }
  });

  const itLinux = process.platform === "linux" ? it : it.skip;

  itLinux(
    "rejects process file descriptors directly and through a directory symlink",
    async () => {
      const rawRoot = mkdtempSync(
        path.join(tmpdir(), "eliza-sandbox-proc-fd-"),
      );
      try {
        const root = realpathSync(rawRoot);
        const fdDirectory = `/proc/${process.pid}/fd`;
        const alias = path.join(root, "process-fds");
        symlinkSync(fdDirectory, alias, "dir");
        const entryAlias = path.join(root, "stdin-fd");
        symlinkSync(path.join(fdDirectory, "0"), entryAlias, "file");
        const directoryTarget = path.join(root, "directory-target");
        mkdirSync(directoryTarget);
        writeFileSync(
          path.join(directoryTarget, "child.txt"),
          "blocked through fd identity",
        );
        const directoryFd = openSync(directoryTarget, "r");
        const directoryEntryAlias = path.join(root, "directory-fd");
        symlinkSync(
          path.join(fdDirectory, String(directoryFd)),
          directoryEntryAlias,
          "dir",
        );
        const svc = await SandboxService.start(
          mockRuntime({
            CODING_TOOLS_BLOCKED_PATHS: path.join(root, "unused"),
          }),
        );

        try {
          for (const candidate of [
            path.join(fdDirectory, "0"),
            `/proc/self/fd/0`,
            `/proc/${process.pid}/task/${process.pid}/fd/0`,
            `/proc/self/task/${process.pid}/fd/0`,
            "/proc/thread-self/fd/0",
            "/proc/self/cwd",
            `/proc/${process.pid}/root/etc/hostname`,
            "/proc/self/exe",
            path.join(alias, "0"),
            entryAlias,
            directoryEntryAlias,
            path.join(directoryEntryAlias, "child.txt"),
          ]) {
            const result = await svc.validatePath(undefined, candidate);
            expect(result.ok, candidate).toBe(false);
            if (!result.ok) expect(result.reason).toBe("blocked");
          }
        } finally {
          closeSync(directoryFd);
        }
      } finally {
        rmSync(rawRoot, { recursive: true, force: true });
      }
    },
  );

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

  const itSymlink = process.platform === "win32" ? it.skip : it;
  itSymlink(
    "rejects a write through a workspace directory symlink to a missing leaf",
    async () => {
      const rawRoot = mkdtempSync(path.join(tmpdir(), "eliza-sandbox-root-"));
      const rawVictim = mkdtempSync(
        path.join(tmpdir(), "eliza-sandbox-victim-"),
      );
      try {
        const root = realpathSync(rawRoot);
        const victim = realpathSync(rawVictim);
        symlinkSync(victim, path.join(root, "escape"), "dir");
        const svc = await SandboxService.start(
          mockRuntime({ CODING_TOOLS_WORKSPACE_ROOTS: root }),
        );
        const result = await svc.validatePath(
          undefined,
          path.join(root, "escape", "planted.txt"),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("outside_allowed_roots");
      } finally {
        rmSync(rawRoot, { recursive: true, force: true });
        rmSync(rawVictim, { recursive: true, force: true });
      }
    },
  );

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

  // The Android blocklist is hard-coded as POSIX-rooted paths (`/vendor`,
  // `/apex`, …) that `loadConfig` runs through `path.resolve`. On a Windows
  // host that rewrites them to `C:\vendor`, so the literal `/vendor`
  // assertion can't hold. The runtime never actually executes on Windows
  // as an Android device, so skip on Windows rather than fabricate a fake
  // platform expectation.
  const itAndroidSim = process.platform === "win32" ? it.skip : it;
  itAndroidSim(
    "adds Android system roots to the default blocklist on AOSP/mobile Android",
    async () => {
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
    },
  );

  it("permits paths outside the blocklist", async () => {
    const svc = await SandboxService.start(mockRuntime());
    const v = await svc.validatePath(
      undefined,
      path.join(homedir(), "totally-fine-dir"),
    );
    expect(v.ok).toBe(true);
  });
});
