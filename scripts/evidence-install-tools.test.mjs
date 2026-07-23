/**
 * Exercises every supported installer plan and boundary with deterministic
 * process fakes; package managers and developer configuration are never
 * mutated by this test process.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSupportedPlatform,
  buildInstallPlan,
  EVIDENCE_REQUIREMENTS,
  executeInstallPlan,
  formatCommand,
  githubInstallSteps,
  mediaInstallSteps,
  parseInstallerArgs,
  refreshWindowsPath,
  resolveMediaRequirements,
  withWindowsWingetLinksPath,
} from "./evidence-install-tools.mjs";

const missing = () => false;
const unavailableMedia = {
  ffmpeg: { available: false, reason: "missing" },
  ffprobe: { available: false, reason: "missing" },
};
const packagedMedia = {
  ffmpeg: { available: true, bin: "/packages/ffmpeg", source: "bundled" },
  ffprobe: { available: true, bin: "/packages/ffprobe", source: "bundled" },
};

describe("evidence tool installer", () => {
  it("shares one immutable baseline requirement catalog", () => {
    assert.deepEqual(
      Object.values(EVIDENCE_REQUIREMENTS)
        .filter(({ requiredByDefault }) => requiredByDefault)
        .map(({ id }) => id),
      ["ocr", "ffmpeg", "ffprobe", "playwright-browsers"],
    );
    assert.equal(EVIDENCE_REQUIREMENTS.githubCli.id, "github-cli");
    assert.equal(EVIDENCE_REQUIREMENTS.githubCli.requiredByDefault, false);
    assert.equal(Object.isFrozen(EVIDENCE_REQUIREMENTS), true);
    assert.equal(Object.isFrozen(EVIDENCE_REQUIREMENTS.ffmpeg), true);
  });

  it("installs workspace packages and the Linux Chromium dependency helper", () => {
    const plan = buildInstallPlan({
      platform: "linux",
      mediaOptions: { resolutions: packagedMedia },
    });
    assert.deepEqual(plan[0], {
      label: "workspace evidence dependencies",
      bin: "bun",
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
    });
    assert.deepEqual(
      plan.slice(1, 3).map(({ bin, args }) => ({ bin, args })),
      [
        { bin: "/packages/ffmpeg", args: ["-version"] },
        { bin: "/packages/ffprobe", args: ["-version"] },
      ],
    );
    assert.equal(plan[3].bin, "bash");
    assert.match(plan[3].args[0], /install-playwright-browsers\.sh$/);
    assert.equal(plan[3].args[1], "chromium");
  });

  it("uses packaged media without planning an unrelated system install", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const plan = mediaInstallSteps(platform, {
        has: missing,
        resolutions: packagedMedia,
      });
      assert.deepEqual(
        plan.map(({ bin }) => bin),
        ["/packages/ffmpeg", "/packages/ffprobe"],
      );
    }
  });

  it("uses native Playwright installation on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"]) {
      const plan = buildInstallPlan({
        platform,
        skipDependencies: true,
        mediaOptions: { resolutions: packagedMedia },
      });
      assert.deepEqual(plan.at(-1), {
        label: "Playwright Chromium",
        bin: "bunx",
        args: ["playwright", "install", "chromium"],
      });
    }
  });

  it("uses Homebrew for missing macOS media and GitHub CLI", () => {
    const hasBrew = (command) => command === "brew";
    assert.deepEqual(
      mediaInstallSteps("darwin", {
        has: hasBrew,
        resolutions: unavailableMedia,
      }),
      [
        {
          label: "ffmpeg and ffprobe",
          bin: "brew",
          args: ["install", "ffmpeg"],
        },
        { label: "ffmpeg verification", bin: "ffmpeg", args: ["-version"] },
        { label: "ffprobe verification", bin: "ffprobe", args: ["-version"] },
      ],
    );
    assert.deepEqual(githubInstallSteps("darwin", { has: hasBrew }), [
      { label: "GitHub CLI", bin: "brew", args: ["install", "gh"] },
      { label: "GitHub CLI verification", bin: "gh", args: ["--version"] },
    ]);
  });

  it("uses unattended exact WinGet packages and refresh markers", () => {
    const hasWinget = (command) => command === "winget";
    const media = mediaInstallSteps("win32", {
      has: hasWinget,
      resolutions: unavailableMedia,
    });
    const github = githubInstallSteps("win32", { has: hasWinget });
    for (const [step, packageId] of [
      [media[0], "Gyan.FFmpeg"],
      [github[0], "GitHub.cli"],
    ]) {
      assert.equal(step.bin, "winget");
      assert.equal(step.refreshWindowsPath, true);
      assert.ok(step.args.includes(packageId));
      for (const flag of [
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
        "--disable-interactivity",
      ]) {
        assert.ok(step.args.includes(flag), `${packageId} lacks ${flag}`);
      }
      assert.ok(!step.args.some((arg) => /token|password|secret/iu.test(arg)));
    }
    assert.deepEqual(
      media.slice(1).map(({ bin, args }) => ({ bin, args })),
      [
        { bin: "ffmpeg", args: ["-version"] },
        { bin: "ffprobe", args: ["-version"] },
      ],
    );
    assert.deepEqual(github.at(-1), {
      label: "GitHub CLI verification",
      bin: "gh",
      args: ["--version"],
    });
  });

  it("covers apt, dnf, yum, and apk as root and non-root", () => {
    const cases = [
      {
        manager: "apt-get",
        media: ["install", "-y", "ffmpeg"],
        github: ["install", "-y", "gh"],
        updates: true,
      },
      {
        manager: "dnf",
        media: ["install", "-y", "ffmpeg"],
        github: ["install", "-y", "gh"],
      },
      {
        manager: "yum",
        media: ["install", "-y", "ffmpeg"],
        github: ["install", "-y", "gh"],
      },
      {
        manager: "apk",
        media: ["add", "--no-cache", "ffmpeg"],
        github: ["add", "--no-cache", "github-cli"],
      },
    ];
    for (const testCase of cases) {
      const hasManager = (command) => command === testCase.manager;
      const rootMedia = mediaInstallSteps("linux", {
        has: hasManager,
        isRoot: true,
        resolutions: unavailableMedia,
      });
      const rootGithub = githubInstallSteps("linux", {
        has: hasManager,
        isRoot: true,
      });
      assert.ok(
        rootMedia.some(
          ({ bin, args }) =>
            bin === testCase.manager &&
            JSON.stringify(args) === JSON.stringify(testCase.media),
        ),
      );
      assert.ok(
        rootGithub.some(
          ({ bin, args }) =>
            bin === testCase.manager &&
            JSON.stringify(args) === JSON.stringify(testCase.github),
        ),
      );

      const nonRootMedia = mediaInstallSteps("linux", {
        has: hasManager,
        isRoot: false,
        resolutions: unavailableMedia,
      });
      const nonRootGithub = githubInstallSteps("linux", {
        has: hasManager,
        isRoot: false,
      });
      for (const plan of [nonRootMedia, nonRootGithub]) {
        assert.deepEqual(plan[0], {
          label: "passwordless sudo preflight",
          bin: "sudo",
          args: ["-n", "true"],
          failureMessage:
            "Evidence tool installation requires passwordless sudo on this unattended runner. Install the tools manually or grant this runner noninteractive sudo, then rerun.",
        });
        assert.ok(
          plan
            .filter(({ bin }) => bin === "sudo")
            .every(({ args }) => args[0] === "-n"),
        );
      }
      if (testCase.updates) {
        assert.ok(
          rootMedia.some(
            ({ bin, args }) =>
              bin === "apt-get" &&
              JSON.stringify(args) === JSON.stringify(["update"]),
          ),
        );
      }
    }
  });

  it("keeps pacman and zypper supported by the same Linux planner", () => {
    for (const manager of ["pacman", "zypper"]) {
      const plan = mediaInstallSteps("linux", {
        has: (command) => command === manager,
        isRoot: true,
        resolutions: unavailableMedia,
      });
      assert.equal(plan[0].bin, manager);
      assert.equal(plan.at(-1).bin, "ffprobe");
    }
  });

  it("refreshes WinGet links plus registry PATH before same-process probes", () => {
    const initial = {
      LOCALAPPDATA: String.raw`C:\Users\agent\AppData\Local`,
      Path: String.raw`C:\Windows\System32`,
    };
    const seeded = withWindowsWingetLinksPath(initial);
    assert.equal(
      seeded.Path,
      String.raw`C:\Users\agent\AppData\Local\Microsoft\WinGet\Links;C:\Windows\System32`,
    );
    assert.equal(initial.Path, String.raw`C:\Windows\System32`);
    assert.equal(withWindowsWingetLinksPath(seeded).Path, seeded.Path);
    assert.throws(
      () => withWindowsWingetLinksPath({ Path: "C:\\Windows" }),
      /LOCALAPPDATA is unavailable/,
    );

    const refreshed = refreshWindowsPath(seeded, {
      run: () => ({
        status: 0,
        stdout:
          String.raw`C:\Program Files\MachineTool` +
          "\n" +
          String.raw`C:\Users\agent\UserTool`,
      }),
    });
    assert.match(refreshed.Path, /UserTool/);
    assert.match(refreshed.Path, /MachineTool/);
    assert.match(refreshed.Path, /WinGet\\Links/);
    assert.equal(
      refreshed.Path.split(";").filter((entry) => /WinGet\\Links/i.test(entry))
        .length,
      1,
    );
  });

  it("uses refreshed Windows PATH for the very next verification process", () => {
    const calls = [];
    const run = (bin, args, options) => {
      calls.push({ bin, args, envPath: options.env?.Path });
      if (bin === "powershell.exe") {
        return {
          status: 0,
          stdout: `${String.raw`C:\Program Files\GitHub CLI`}\n`,
        };
      }
      return { status: 0 };
    };
    executeInstallPlan(
      [
        {
          label: "GitHub CLI",
          bin: "winget",
          args: ["install", "--id", "GitHub.cli"],
          refreshWindowsPath: true,
        },
        {
          label: "GitHub CLI verification",
          bin: "gh",
          args: ["--version"],
        },
      ],
      {
        platform: "win32",
        env: {
          LOCALAPPDATA: String.raw`C:\Users\agent\AppData\Local`,
          Path: String.raw`C:\Windows`,
        },
        run,
      },
    );
    assert.match(calls.find(({ bin }) => bin === "gh").envPath, /GitHub CLI/);
  });

  it("executes argument vectors directly and quotes hostile dry-run tokens", () => {
    const hostile = "$(touch /tmp/should-not-exist); 'quoted'";
    assert.equal(
      formatCommand({ bin: "tool", args: [hostile] }, "linux"),
      `tool '$(touch /tmp/should-not-exist); '"'"'quoted'"'"''`,
    );
    assert.equal(
      formatCommand({ bin: "tool", args: [hostile] }, "win32"),
      "tool '$(touch /tmp/should-not-exist); ''quoted'''",
    );

    const invocations = [];
    executeInstallPlan(
      [{ label: "hostile argument", bin: "tool", args: [hostile] }],
      {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        run: (bin, args, options) => {
          invocations.push({ bin, args, options });
          return { status: 0 };
        },
      },
    );
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].args, [hostile]);
    assert.equal(invocations[0].options.shell, undefined);
  });

  it("fails closed on unsupported hosts, missing managers, and unknown flags", () => {
    for (const platform of ["aix", "freebsd", "sunos"]) {
      assert.throws(
        () => assertSupportedPlatform(platform),
        /unsupported operating system/,
      );
      assert.throws(
        () => buildInstallPlan({ platform, skipDependencies: true }),
        /unsupported operating system/,
      );
    }
    assert.throws(
      () =>
        mediaInstallSteps("darwin", {
          has: missing,
          resolutions: unavailableMedia,
        }),
      /Homebrew is missing/,
    );
    assert.throws(
      () =>
        mediaInstallSteps("win32", {
          has: missing,
          resolutions: unavailableMedia,
        }),
      /WinGet is missing/,
    );
    assert.throws(
      () =>
        mediaInstallSteps("linux", {
          has: missing,
          resolutions: unavailableMedia,
        }),
      /no supported Linux package manager/,
    );
    assert.throws(
      () => githubInstallSteps("darwin", { has: missing }),
      /Homebrew is unavailable/,
    );
    assert.throws(
      () => githubInstallSteps("win32", { has: missing }),
      /WinGet is unavailable/,
    );
    assert.throws(
      () => githubInstallSteps("linux", { has: missing }),
      /no supported Linux package manager/,
    );
    assert.throws(
      () => parseInstallerArgs(["--strcit"]),
      /unknown argument\(s\): --strcit/,
    );
    assert.deepEqual(parseInstallerArgs(["--dry-run", "--github"]), {
      includeGithub: true,
      skipDependencies: false,
      dryRun: true,
      help: false,
    });
  });

  it("surfaces process start, exit, sudo, and Windows PATH refresh failures", () => {
    assert.throws(
      () =>
        executeInstallPlan(
          [{ label: "broken executable", bin: "missing", args: [] }],
          {
            platform: "linux",
            run: () => ({ error: new Error("spawn failed") }),
          },
        ),
      /broken executable could not start: spawn failed/,
    );
    assert.throws(
      () =>
        executeInstallPlan(
          [{ label: "broken install", bin: "tool", args: ["install"] }],
          {
            platform: "linux",
            run: () => ({ status: 17 }),
          },
        ),
      /broken install failed with exit code 17/,
    );

    const sudoPlan = mediaInstallSteps("linux", {
      has: (command) => command === "apt-get",
      isRoot: false,
      resolutions: unavailableMedia,
    });
    assert.throws(
      () =>
        executeInstallPlan(sudoPlan, {
          platform: "linux",
          run: () => ({ status: 1 }),
        }),
      /requires passwordless sudo/,
    );
    assert.throws(
      () =>
        refreshWindowsPath(
          {
            LOCALAPPDATA: String.raw`C:\Users\agent\AppData\Local`,
            Path: String.raw`C:\Windows`,
          },
          { run: () => ({ status: 9 }) },
        ),
      /PowerShell exited 9/,
    );
  });

  it("returns existing media resolutions without fabricating availability", async () => {
    const resolutions = await resolveMediaRequirements({
      resolveFfmpeg: async () => packagedMedia.ffmpeg,
      resolveFfprobe: async () => packagedMedia.ffprobe,
    });
    assert.deepEqual(resolutions, packagedMedia);
  });

  it("makes dry-run and invalid CLI invocations non-mutating and bounded", () => {
    const script = fileURLToPath(
      new URL("./evidence-install-tools.mjs", import.meta.url),
    );
    const dryRun = spawnSync(process.execPath, [script, "--dry-run"], {
      encoding: "utf8",
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /playwright/);
    assert.doesNotMatch(dryRun.stdout, /\[install\]/);

    const invalid = spawnSync(process.execPath, [script, "--strcit"], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(
      invalid.stderr,
      /evidence-install-tools: unknown argument\(s\): --strcit/,
    );
  });
});
