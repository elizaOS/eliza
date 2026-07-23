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
  EVIDENCE_REQUIREMENTS,
  executeInstallPlan,
  formatCommand,
  githubInstallSteps,
  InstallStepError,
  mediaInstallSteps,
  parseInstallerArgs,
  refreshWindowsPath,
  resolveInstallPlan,
  resolveMediaRequirements,
  resolveStepTimeoutScale,
  STEP_TIMEOUT_DEFAULTS_MS,
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

  it("resolves one plan for display and execution from injected media", async () => {
    const plan = await resolveInstallPlan({
      platform: "linux",
      mediaOptions: { resolutions: packagedMedia },
    });
    assert.equal(plan.deferredMedia, false);
    assert.deepEqual(plan.assumptions, []);
    assert.deepEqual(plan.steps[0], {
      label: "workspace evidence dependencies",
      bin: "bun",
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
      timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
    });
    assert.deepEqual(
      plan.steps.slice(1, 3).map(({ bin, args }) => ({ bin, args })),
      [
        { bin: "/packages/ffmpeg", args: ["-version"] },
        { bin: "/packages/ffprobe", args: ["-version"] },
      ],
    );
    assert.equal(plan.steps[3].bin, "bash");
    assert.match(plan.steps[3].args[0], /install-playwright-browsers\.sh$/);
    assert.equal(plan.steps[3].args[1], "chromium");
    const doctor = plan.steps.at(-1);
    assert.equal(doctor.label, "evidence toolchain verification");
    assert.match(doctor.args[0], /evidence-doctor\.mjs$/);
    assert.deepEqual(doctor.args.slice(1), ["--strict"]);
  });

  it("resolves media through the shared resolver exactly like execution", async () => {
    let resolverCalls = 0;
    const plan = await resolveInstallPlan(
      { platform: "linux", skipDependencies: true },
      {
        resolveMedia: async () => {
          resolverCalls += 1;
          return packagedMedia;
        },
      },
    );
    assert.equal(resolverCalls, 1);
    assert.deepEqual(
      plan.steps.slice(0, 2).map(({ bin }) => bin),
      ["/packages/ffmpeg", "/packages/ffprobe"],
    );
  });

  it("defers unresolved media to a post-dependency re-resolution with an explicit assumption", async () => {
    const plan = await resolveInstallPlan(
      { platform: "darwin" },
      { resolveMedia: async () => unavailableMedia },
    );
    assert.equal(plan.deferredMedia, true);
    assert.equal(plan.assumptions.length, 1);
    assert.match(plan.assumptions[0], /workspace dependency step/);
    assert.match(plan.assumptions[0], /re-resolves/);
    // No premature system install is planned from pre-dependency state.
    assert.ok(!plan.steps.some(({ bin }) => bin === "brew"));
    assert.deepEqual(
      plan.steps.map(({ label }) => label),
      [
        "workspace evidence dependencies",
        "Playwright Chromium",
        "evidence toolchain verification",
      ],
    );
  });

  it("never defers when dependencies are skipped: unresolved media plans a system install", async () => {
    const plan = await resolveInstallPlan(
      {
        platform: "darwin",
        skipDependencies: true,
        mediaOptions: { has: (command) => command === "brew" },
      },
      { resolveMedia: async () => unavailableMedia },
    );
    assert.equal(plan.deferredMedia, false);
    assert.deepEqual(plan.assumptions, []);
    assert.ok(
      plan.steps.some(
        ({ bin, args }) =>
          bin === "brew" && JSON.stringify(args) === '["install","ffmpeg"]',
      ),
    );
  });

  it("gives every planned step a positive deadline", async () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const plan = await resolveInstallPlan({
        platform,
        includeGithub: true,
        githubOptions: { has: (command) => command === "gh" },
        mediaOptions: { resolutions: packagedMedia },
      });
      for (const step of plan.steps) {
        assert.ok(
          Number.isFinite(step.timeoutMs) && step.timeoutMs > 0,
          `${platform} step ${step.label} lacks a deadline`,
        );
      }
    }
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

  it("requires explicit media resolutions instead of presence shortcuts", () => {
    assert.throws(
      () => mediaInstallSteps("darwin", { has: missing }),
      /requires ffmpeg\/ffprobe resolutions/,
    );
  });

  it("uses native Playwright installation on macOS and Windows", async () => {
    for (const platform of ["darwin", "win32"]) {
      const plan = await resolveInstallPlan({
        platform,
        skipDependencies: true,
        mediaOptions: { resolutions: packagedMedia },
      });
      assert.deepEqual(plan.steps.at(-2), {
        label: "Playwright Chromium",
        bin: "bunx",
        args: ["playwright", "install", "chromium"],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
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
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
        },
        {
          label: "ffmpeg verification",
          bin: "ffmpeg",
          args: ["-version"],
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
        },
        {
          label: "ffprobe verification",
          bin: "ffprobe",
          args: ["-version"],
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
        },
      ],
    );
    assert.deepEqual(githubInstallSteps("darwin", { has: hasBrew }), [
      {
        label: "GitHub CLI",
        bin: "brew",
        args: ["install", "gh"],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
      },
      {
        label: "GitHub CLI verification",
        bin: "gh",
        args: ["--version"],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
      },
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
      assert.equal(step.timeoutMs, STEP_TIMEOUT_DEFAULTS_MS.packageManager);
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
      timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
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
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
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
    // Registry values merge in Windows' effective order: Machine before User.
    const entries = refreshed.Path.split(";");
    assert.ok(
      entries.indexOf(String.raw`C:\Program Files\MachineTool`) <
        entries.indexOf(String.raw`C:\Users\agent\UserTool`),
    );
    assert.equal(
      entries.filter((entry) => /WinGet\\Links/i.test(entry)).length,
      1,
    );
  });

  it("bounds the PowerShell PATH refresh and reports its timeout", () => {
    const options = [];
    refreshWindowsPath(
      {
        LOCALAPPDATA: String.raw`C:\Users\agent\AppData\Local`,
        Path: String.raw`C:\Windows`,
      },
      {
        run: (_bin, _args, runOptions) => {
          options.push(runOptions);
          return { status: 0, stdout: "" };
        },
      },
    );
    assert.equal(options[0].timeout, STEP_TIMEOUT_DEFAULTS_MS.probe);
    assert.throws(
      () =>
        refreshWindowsPath(
          {
            LOCALAPPDATA: String.raw`C:\Users\agent\AppData\Local`,
            Path: String.raw`C:\Windows`,
          },
          {
            run: () => ({
              error: Object.assign(new Error("timed out"), {
                code: "ETIMEDOUT",
              }),
            }),
          },
        ),
      (error) =>
        error instanceof InstallStepError &&
        error.code === "step-timeout" &&
        /Windows PATH refresh timed out/.test(error.message),
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
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
          refreshWindowsPath: true,
        },
        {
          label: "GitHub CLI verification",
          bin: "gh",
          args: ["--version"],
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
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
      [
        {
          label: "hostile argument",
          bin: "tool",
          args: [hostile],
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
        },
      ],
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

  it("passes scaled per-step deadlines to every spawned process", () => {
    const invocations = [];
    executeInstallPlan(
      [
        {
          label: "bounded install",
          bin: "tool",
          args: ["install"],
          timeoutMs: 600_000,
        },
      ],
      {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        timeoutScale: 2.5,
        run: (bin, _args, options) => {
          invocations.push({ bin, options });
          return { status: 0 };
        },
      },
    );
    assert.equal(invocations[0].options.timeout, 1_500_000);
    assert.equal(invocations[0].options.killSignal, "SIGKILL");
  });

  it("rejects planned steps without a deadline instead of running unbounded", () => {
    assert.throws(
      () =>
        executeInstallPlan(
          [{ label: "unbounded step", bin: "tool", args: [] }],
          {
            platform: "linux",
            run: () => ({ status: 0 }),
          },
        ),
      (error) =>
        error instanceof InstallStepError &&
        error.code === "step-plan" &&
        /unbounded step has no per-step deadline/.test(error.message),
    );
  });

  it("turns a step deadline overrun into a typed named failure with operator guidance", () => {
    assert.throws(
      () =>
        executeInstallPlan(
          [
            {
              label: "stuck package manager",
              bin: "tool",
              args: ["install"],
              timeoutMs: 60_000,
            },
          ],
          {
            platform: "linux",
            run: () => ({
              error: Object.assign(new Error("spawnSync tool ETIMEDOUT"), {
                code: "ETIMEDOUT",
              }),
              signal: "SIGKILL",
            }),
          },
        ),
      (error) =>
        error instanceof InstallStepError &&
        error.code === "step-timeout" &&
        error.step === "stuck package manager" &&
        /timed out after 1m/.test(error.message) &&
        /--timeout-scale=/.test(error.message) &&
        /ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE/.test(error.message),
    );
  });

  it("resolves the deadline scale from flag or environment and rejects nonsense", () => {
    assert.equal(resolveStepTimeoutScale({}, undefined), 1);
    assert.equal(resolveStepTimeoutScale({}, "3"), 3);
    assert.equal(
      resolveStepTimeoutScale(
        { ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE: "0.5" },
        undefined,
      ),
      0.5,
    );
    // An explicit flag beats the environment.
    assert.equal(
      resolveStepTimeoutScale(
        { ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE: "9" },
        "2",
      ),
      2,
    );
    for (const bad of ["0", "-1", "banana", "Infinity"]) {
      assert.throws(
        () => resolveStepTimeoutScale({}, bad),
        /invalid step timeout scale/,
      );
    }
  });

  it("fails closed on unsupported hosts, missing managers, and unknown flags", async () => {
    for (const platform of ["aix", "freebsd", "sunos"]) {
      assert.throws(
        () => assertSupportedPlatform(platform),
        /unsupported operating system/,
      );
      await assert.rejects(
        resolveInstallPlan(
          { platform, skipDependencies: true },
          { resolveMedia: async () => packagedMedia },
        ),
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
    assert.throws(
      () => parseInstallerArgs(["--strict"]),
      /--strict requires --dry-run/,
    );
    assert.deepEqual(
      parseInstallerArgs(["--dry-run", "--github", "--timeout-scale=2"]),
      {
        includeGithub: true,
        skipDependencies: false,
        dryRun: true,
        strict: false,
        timeoutScale: "2",
        help: false,
      },
    );
    assert.deepEqual(parseInstallerArgs(["--dry-run", "--strict"]), {
      includeGithub: false,
      skipDependencies: false,
      dryRun: true,
      strict: true,
      timeoutScale: undefined,
      help: false,
    });
  });

  it("surfaces process start, exit, sudo, and Windows PATH refresh failures", () => {
    assert.throws(
      () =>
        executeInstallPlan(
          [
            {
              label: "broken executable",
              bin: "missing",
              args: [],
              timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
            },
          ],
          {
            platform: "linux",
            run: () => ({ error: new Error("spawn failed") }),
          },
        ),
      (error) =>
        error instanceof InstallStepError &&
        error.code === "step-start" &&
        /broken executable could not start: spawn failed/.test(error.message),
    );
    assert.throws(
      () =>
        executeInstallPlan(
          [
            {
              label: "broken install",
              bin: "tool",
              args: ["install"],
              timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
            },
          ],
          {
            platform: "linux",
            run: () => ({ status: 17 }),
          },
        ),
      (error) =>
        error instanceof InstallStepError &&
        error.code === "step-exit" &&
        /broken install failed with exit code 17/.test(error.message),
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
    // An unresolvable env pin forces the deferred-media path so this spawn is
    // deterministic on any host: no media resolution, no system install plan.
    const deferredEnv = {
      ...process.env,
      ELIZA_FFMPEG_BIN: "/nonexistent/evidence-doctor-test-ffmpeg",
      ELIZA_FFPROBE_BIN: "/nonexistent/evidence-doctor-test-ffprobe",
    };
    const dryRun = spawnSync(process.execPath, [script, "--dry-run"], {
      encoding: "utf8",
      env: deferredEnv,
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /playwright/);
    assert.match(dryRun.stdout, /evidence-doctor\.mjs/);
    assert.match(dryRun.stdout, /# assumes: /);
    assert.doesNotMatch(dryRun.stdout, /\[install\]/);

    const strictDryRun = spawnSync(
      process.execPath,
      [script, "--dry-run", "--strict"],
      { encoding: "utf8", env: deferredEnv },
    );
    assert.equal(strictDryRun.status, 1);
    assert.match(strictDryRun.stdout, /# assumes: /);
    assert.match(
      strictDryRun.stderr,
      /--strict dry run: the plan could not be fully resolved/,
    );

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
