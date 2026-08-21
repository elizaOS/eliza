/** Tests for the SandboxService path policy: blocklist defaults and allow-root enforcement. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

describe("SandboxService canonical confinement (#22944)", () => {
  const temps: string[] = [];

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
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-ct-"));
    temps.push(dir);
    return dir;
  }

  async function startWithRoots(roots: string, blocked?: string) {
    process.env.CODING_TOOLS_WORKSPACE_ROOTS = roots;
    if (blocked !== undefined) {
      process.env.CODING_TOOLS_BLOCKED_PATHS_ADD = blocked;
    }
    return SandboxService.start(mockRuntime());
  }

  it("denies a dangling-symlink component inside an allowed root", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    symlinkSync(
      path.join(realRoot, "gone"),
      path.join(realRoot, "dangling"),
      "dir",
    );
    const svc = (await startWithRoots(realRoot)) as SandboxService;
    const verdict = await svc.validatePath(
      undefined,
      path.join(realRoot, "dangling", "planted.txt"),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("unresolvable_path");
  });

  it("allows a dot-dot-prefixed sibling name inside an allowed root", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    const svc = (await startWithRoots(realRoot)) as SandboxService;
    const verdict = await svc.validatePath(
      undefined,
      path.join(realRoot, "..safe.js"),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.resolved).toBe(path.join(realRoot, "..safe.js"));
    }
  });

  it("keeps blocking an unresolvable blocklist entry by its lexical spelling", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    const ghost = path.join(realRoot, "ghost-dir");
    symlinkSync(path.join(realRoot, "nowhere"), ghost, "dir");
    const svc = (await startWithRoots(realRoot, ghost)) as SandboxService;
    const verdict = await svc.validatePath(
      undefined,
      path.join(ghost, "secret.txt"),
    );
    expect(verdict.ok).toBe(false);
    // The candidate's own dangling component fails closed before the
    // blocklist; the entry itself must still be present, not dropped.
    expect(svc.getBlockedPaths()).toContain(ghost);
  });

  it("matches a blocklist entry given in its aliased spelling (macOS /var vs /private/var)", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    if (realRoot === path.resolve(root)) {
      // No aliasing on this platform (plain Linux tmpdir); the dual-form
      // matrix is still exercised by the canonical-vs-canonical arm below.
      const svc = (await startWithRoots(realRoot, realRoot)) as SandboxService;
      const verdict = await svc.validatePath(
        undefined,
        path.join(realRoot, "x.txt"),
      );
      expect(verdict.ok).toBe(false);
      return;
    }
    // Configure the blocklist with the UNcanonicalized spelling; validate a
    // candidate that resolves to the canonical one.
    const svc = (await startWithRoots(
      path.resolve(root),
      path.resolve(root),
    )) as SandboxService;
    const verdict = await svc.validatePath(
      undefined,
      path.join(realRoot, "x.txt"),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("blocked");
  });

  it("never drops an unresolvable allow-root into the empty-list bypass", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    const missingRoot = path.join(realRoot, "not-created-yet");
    const svc = (await startWithRoots(missingRoot)) as SandboxService;
    // The allowlist must still be enforced: a path outside the (sole,
    // unresolvable) root is refused rather than allowed by an emptied list.
    const outside = await svc.validatePath(
      undefined,
      path.join(realRoot, "outside.txt"),
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe("outside_allowed_roots");
    // And a path under the root's lexical spelling stays admissible.
    const inside = await svc.validatePath(
      undefined,
      path.join(missingRoot, "file.txt"),
    );
    expect(inside.ok).toBe(true);
  });
});

describe("SandboxService blocklist resolution drift (#22944)", () => {
  const temps: string[] = [];

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
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  const itNonRoot =
    process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

  itNonRoot(
    "admits a root that was unreadable at start once it resolves again",
    async () => {
      const base = mkdtempSync(path.join(tmpdir(), "eliza-ct-eacces-"));
      temps.push(base);
      const real = realpathSync(base);
      const locked = path.join(real, "locked");
      const ws = path.join(locked, "ws");
      mkdirSync(locked);
      mkdirSync(ws);
      chmodSync(locked, 0o000);
      try {
        process.env.CODING_TOOLS_WORKSPACE_ROOTS = ws;
        const svc = await SandboxService.start(mockRuntime());
        // Entry canonicalization failed (EACCES) — the root must survive in
        // lexical form rather than emptying the allowlist or denying forever.
        chmodSync(locked, 0o755);
        const verdict = await svc.validatePath(
          undefined,
          path.join(ws, "file.txt"),
        );
        expect(verdict.ok).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  itSymlink(
    "still blocks a blocklist symlink retargeted after service start",
    async () => {
      const base = mkdtempSync(path.join(tmpdir(), "eliza-ct-drift-"));
      temps.push(base);
      const real = realpathSync(base);
      const targetA = path.join(real, "target-a");
      const targetB = path.join(real, "target-b");
      const alias = path.join(real, "alias");
      mkdirSync(targetA);
      mkdirSync(targetB);
      symlinkSync(targetA, alias, "dir");

      process.env.CODING_TOOLS_BLOCKED_PATHS_ADD = alias;
      const svc = await SandboxService.start(mockRuntime());

      // Retarget the alias AFTER the entry canonicalized to target-a, but
      // BEFORE validatePath runs — this covers policy-entry drift (a stored
      // canonical form going stale), NOT validate-to-use race safety, which
      // this policy does not provide (see the service header).
      rmSync(alias);
      symlinkSync(targetB, alias, "dir");

      const verdict = await svc.validatePath(
        undefined,
        path.join(alias, "secret.txt"),
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("blocked");
    },
  );
});
