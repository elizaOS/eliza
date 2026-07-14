/**
 * Exercises the installed-package verifier with real child processes and
 * locks packaging workflows to the fail-closed verifier instead of masked
 * launcher commands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedServiceEnvironment,
  main,
  parseArguments,
  runCommand,
  verifyPackagedCli,
  verifyPackagedService,
} from "../verify-packaged-cli.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const verifier = new URL("../verify-packaged-cli.mjs", import.meta.url);
const temporaryDirectories: string[] = [];
const nodeOptionsEnvKey = ["NODE", "OPTIONS"].join("_");
const unrelatedEnvKey = ["PACKAGE", "SMOKE", "UNRELATED"].join("_");

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port");
  }
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

function fixture(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-cli-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "packaged-cli");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash\nset -euo pipefail\n${contents}`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

function verify(executable: string, expected = "2.0.0"): string {
  return verifyPackagedCli(executable, [], expected);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged CLI verification", () => {
  test("accepts an executable with the exact version and usable help", () => {
    const executable = fixture(`
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n' ;;
  *) exit 64 ;;
esac
`);

    expect(verify(executable)).toContain("eliza [options]");
  });

  test("preserves a symlink shim path used for argv-zero dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-shim-"));
    temporaryDirectories.push(directory);
    const multiplexer = join(directory, "multiplexer");
    const shim = join(directory, "elizaos-app");
    writeFileSync(
      multiplexer,
      `#!/bin/sh
if [ "$(basename "$0")" != "elizaos-app" ]; then exit 71; fi
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n' ;;
  *) exit 64 ;;
esac
`,
    );
    chmodSync(multiplexer, 0o755);
    symlinkSync(multiplexer, shim);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? "/usr/bin:/bin"}`;
    try {
      expect(verifyPackagedCli("elizaos-app", [], "2.0.0")).toContain(
        "eliza [options]",
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("isolates version and help from host home files and arbitrary env", () => {
    const hostHome = mkdtempSync(join(tmpdir(), "eliza-packaged-cli-home-"));
    temporaryDirectories.push(hostHome);
    writeFileSync(join(hostHome, "credentials"), "host credential\n");
    const executable = fixture(`
if [[ -e "$HOME/credentials" || -n "\${PACKAGE_SMOKE_UNRELATED:-}" || -n "\${NODE_OPTIONS:-}" ]]; then
  exit 70
fi
case "\${1:-}" in
  --version) printf '2.0.0\n' ;;
  --help) printf 'Usage:\n  eliza [options]\n\nOptions:\n  --help  Show help\n' ;;
  *) exit 64 ;;
esac
`);
    const previousHome = process.env.HOME;
    const previousNodeOptions = process.env[nodeOptionsEnvKey];
    process.env.HOME = hostHome;
    process.env[unrelatedEnvKey] = "must-not-reach-child";
    process.env[nodeOptionsEnvKey] = "--trace-warnings";
    try {
      expect(verify(executable)).toContain("eliza [options]");
    } finally {
      delete process.env[unrelatedEnvKey];
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousNodeOptions === undefined)
        delete process.env[nodeOptionsEnvKey];
      else process.env[nodeOptionsEnvKey] = previousNodeOptions;
    }
  });

  test("rejects a launcher that cannot start its version path", () => {
    const executable = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf 'missing runtime dependency\\n' >&2
  exit 1
fi
printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n'
`);

    expect(() => verify(executable)).toThrow("exited 1");
  });

  test("rejects the wrong installed version", () => {
    const executable = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '1.9.9\\n'
else
  printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n'
fi
`);

    expect(() => verify(executable)).toThrow("version mismatch");
  });

  test("rejects failed or content-free help", () => {
    const failedHelp = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.0.0\\n'
else
  exit 2
fi
`);
    const contentFreeHelp = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.0.0\\n'
else
  printf 'installed\\n'
fi
`);

    expect(() => verify(failedHelp)).toThrow("exited 2");
    expect(() => verify(contentFreeHelp)).toThrow("usable Usage");
  });

  test("hard-kills a packaged command that hangs", () => {
    const executable = fixture("sleep 60\n");
    const startedAt = Date.now();

    expect(() =>
      runCommand(executable, ["--version"], { timeoutMs: 100 }),
    ).toThrow("timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("parses wrapper arguments and exercises the command-line boundary", () => {
    const executable = fixture(`
if [[ "\${1:-}" == "wrapped" ]]; then shift; fi
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n' ;;
  *) exit 64 ;;
esac
`);

    expect(
      parseArguments(["--expected", "2.0.0", "--", executable, "wrapped"]),
    ).toEqual({
      command: executable,
      commandArgs: ["wrapped"],
      expectedVersion: "2.0.0",
      healthUrl: undefined,
      isolationRoot: undefined,
      serviceArgs: [],
      serviceTimeoutMs: 180_000,
    });

    const result = Bun.spawnSync({
      cmd: [
        "node",
        verifier.pathname,
        "--expected",
        "2.0.0",
        "--",
        executable,
        "wrapped",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Verified packaged CLI 2.0.0");
  });

  test("boots a real HTTP service from an empty working directory", async () => {
    const executable = fixture(`
if [[ "\${1:-}" != "serve" ]]; then exit 64; fi
exec node -e '
  const http = require("node:http");
  const port = Number(process.env.ELIZA_API_PORT);
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 0 },
      deferredBoot: { phases: { "agent-deferred-boot": "complete" }, settled: true },
      verificationNonce: process.env.ELIZA_PACKAGE_SMOKE_NONCE,
      cwd: process.cwd(),
      stateDir: process.env.ELIZA_STATE_DIR,
      configPath: process.env.ELIZA_CONFIG_PATH,
      home: process.env.HOME,
      xdgDataHome: process.env.XDG_DATA_HOME,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      subscriptionCredentialsDisabled:
        process.env.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS,
      inheritedSecret: process.env.PACKAGE_SMOKE_API_KEY ?? null,
      inheritedUnrelated: process.env.PACKAGE_SMOKE_UNRELATED ?? null,
      hostCredentialReadable: require("node:fs").existsSync(
        require("node:path").join(process.env.HOME, "credentials")
      )
    }));
  }).listen(port, "127.0.0.1");
'
`);
    const port = await availablePort();
    const inheritedSecretKey = ["PACKAGE", "SMOKE", "API_KEY"].join("_");
    const inheritedUnrelatedKey = ["PACKAGE", "SMOKE", "UNRELATED"].join("_");
    const hostHome = mkdtempSync(join(tmpdir(), "eliza-packaged-host-home-"));
    temporaryDirectories.push(hostHome);
    writeFileSync(join(hostHome, "credentials"), "must not be readable\n");
    const previousHome = process.env.HOME;
    const previousNodeOptions = process.env[nodeOptionsEnvKey];
    process.env[inheritedSecretKey] = "must-not-reach-child";
    process.env[inheritedUnrelatedKey] = "must-not-reach-child";
    process.env.HOME = hostHome;
    process.env[nodeOptionsEnvKey] = "--trace-warnings";

    const result = await (async () => {
      try {
        return await verifyPackagedService({
          command: executable,
          commandArgs: [],
          healthUrl: `http://127.0.0.1:${port}/api/health`,
          serviceArgs: ["serve"],
          timeoutMs: 5_000,
        });
      } finally {
        delete process.env[inheritedSecretKey];
        delete process.env[inheritedUnrelatedKey];
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousNodeOptions === undefined) {
          delete process.env[nodeOptionsEnvKey];
        } else {
          process.env[nodeOptionsEnvKey] = previousNodeOptions;
        }
      }
    })();

    expect(result.health).toMatchObject({
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 0 },
      deferredBoot: { settled: true },
    });
    expect(result.health.cwd).toContain("eliza-package-smoke-");
    expect(result.health.stateDir).toBe(join(result.isolationRoot, "state"));
    expect(result.health.configPath).toBe(
      join(result.isolationRoot, "config", "eliza.json"),
    );
    expect(result.health.home).toBe(join(result.isolationRoot, "home"));
    expect(result.health.xdgDataHome).toBe(join(result.isolationRoot, "data"));
    expect(result.health.nodeOptions).toBeNull();
    expect(result.health.subscriptionCredentialsDisabled).toBe("1");
    expect(result.health.inheritedSecret).toBeNull();
    expect(result.health.inheritedUnrelated).toBeNull();
    expect(result.health.hostCredentialReadable).toBe(false);
  });

  test("uses an environment allowlist and isolated home directories", () => {
    const tokenKey = ["PACKAGE", "SMOKE", "TOKEN"].join("_");
    const unrelatedKey = ["PACKAGE", "SMOKE", "UNRELATED"].join("_");
    process.env[tokenKey] = "secret";
    process.env[unrelatedKey] = "must-not-reach-child";
    const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-env-"));
    temporaryDirectories.push(directory);

    try {
      const env = createIsolatedServiceEnvironment(directory, "43139");
      expect(env[tokenKey]).toBeUndefined();
      expect(env[unrelatedKey]).toBeUndefined();
      expect(env.HOME).toBe(join(directory, "home"));
      expect(env.XDG_DATA_HOME).toBe(join(directory, "data"));
      expect(env.ELIZA_STATE_DIR).toBe(join(directory, "state"));
      expect(env.ELIZA_CONFIG_PATH).toBe(
        join(directory, "config", "eliza.json"),
      );
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env[tokenKey];
      delete process.env[unrelatedKey];
    }
  });

  test("rejects a settled service with structured plugin failures immediately", async () => {
    const executable = fixture(`
if [[ "\${1:-}" != "serve" ]]; then exit 64; fi
exec node -e '
  const http = require("node:http");
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 1, failedNames: ["@elizaos/plugin-broken"] },
      deferredBoot: { phases: { "agent-deferred-boot": "complete" }, settled: true },
      verificationNonce: process.env.ELIZA_PACKAGE_SMOKE_NONCE
    }));
  }).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
'
`);
    const port = await availablePort();
    const startedAt = Date.now();

    await expect(
      verifyPackagedService({
        command: executable,
        commandArgs: [],
        healthUrl: `http://127.0.0.1:${port}/api/health`,
        serviceArgs: ["serve"],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("settled unhealthy (plugins.failed=1)");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test.each([
    ["an empty phase map", {}, "agent-deferred-boot=undefined"],
    [
      "a pending required phase",
      { "agent-deferred-boot": "pending" },
      "agent-deferred-boot=pending",
    ],
  ])("rejects a settled service with %s", async (_label, phases, expected) => {
    const executable = fixture(`
if [[ "\${1:-}" != "serve" ]]; then exit 64; fi
exec node -e '
  const http = require("node:http");
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 0 },
      deferredBoot: { phases: ${JSON.stringify(phases)}, settled: true },
      verificationNonce: process.env.ELIZA_PACKAGE_SMOKE_NONCE
    }));
  }).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
'
`);
    const port = await availablePort();

    await expect(
      verifyPackagedService({
        command: executable,
        commandArgs: [],
        healthUrl: `http://127.0.0.1:${port}/api/health`,
        serviceArgs: ["serve"],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(expected);
  });

  test("rejects a settled service with failed database or agent state", async () => {
    for (const [field, value, expected] of [
      ["database", "error", "database=error"],
      ["agentState", "error", "agentState=error"],
    ] as const) {
      const executable = fixture(`
if [[ "\${1:-}" != "serve" ]]; then exit 64; fi
exec node -e '
  const http = require("node:http");
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const health = {
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 0 },
      deferredBoot: { phases: { "agent-deferred-boot": "complete" }, settled: true },
      verificationNonce: process.env.ELIZA_PACKAGE_SMOKE_NONCE
    };
    health[${JSON.stringify(field)}] = ${JSON.stringify(value)};
    response.end(JSON.stringify(health));
  }).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
'
`);
      const port = await availablePort();
      await expect(
        verifyPackagedService({
          command: executable,
          commandArgs: [],
          healthUrl: `http://127.0.0.1:${port}/api/health`,
          serviceArgs: ["serve"],
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(expected);
    }
  });

  test("refuses an occupied health port before spawning the command", async () => {
    const markerRoot = mkdtempSync(join(tmpdir(), "eliza-port-preflight-"));
    temporaryDirectories.push(markerRoot);
    const marker = join(markerRoot, "spawned");
    const executable = fixture(`
printf 'spawned\\n' > ${JSON.stringify(marker)}
sleep 60
`);
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Occupied-port fixture did not expose a TCP port");
    }
    try {
      await expect(
        verifyPackagedService({
          command: executable,
          commandArgs: [],
          healthUrl: `http://127.0.0.1:${address.port}/api/health`,
          serviceArgs: ["serve"],
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("health port is already in use");
      expect(existsSync(marker)).toBe(false);
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });

  test("rejects an early service exit and an unreachable health boundary", async () => {
    const exited = fixture("exit 7\n");
    const sleeping = fixture("sleep 60\n");
    const earlyExitPort = await availablePort();
    const timeoutPort = await availablePort();

    await expect(
      verifyPackagedService({
        command: exited,
        commandArgs: [],
        healthUrl: `http://127.0.0.1:${earlyExitPort}/api/health`,
        serviceArgs: ["serve"],
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("exited before becoming healthy");
    await expect(
      verifyPackagedService({
        command: sleeping,
        commandArgs: [],
        healthUrl: `http://127.0.0.1:${timeoutPort}/api/health`,
        serviceArgs: ["serve"],
        timeoutMs: 100,
      }),
    ).rejects.toThrow("did not become healthy within 100ms");
  });

  test("runs the combined CLI and service boundary", async () => {
    const executable = fixture(`
case "\${1:-}" in
  --version) printf '2.0.0\\n'; exit 0 ;;
  --help) printf 'Usage:\\n  eliza [options]\\n\\nCommands:\\n  serve  Start API\\n'; exit 0 ;;
  serve) ;;
  *) exit 64 ;;
esac
exec node -e '
  const http = require("node:http");
  http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ready: true,
      runtime: "ok",
      database: "ok",
      agentState: "running",
      plugins: { failed: 0 },
      deferredBoot: { phases: { "agent-deferred-boot": "complete" }, settled: true },
      verificationNonce: process.env.ELIZA_PACKAGE_SMOKE_NONCE
    }));
  }).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
'
`);
    const port = await availablePort();

    await expect(
      main([
        "--expected",
        "2.0.0",
        "--health-url",
        `http://127.0.0.1:${port}/api/health`,
        "--service-arg",
        "serve",
        "--service-timeout-ms",
        "5000",
        "--",
        executable,
      ]),
    ).resolves.toBeUndefined();
  });

  test("never deletes a caller-owned isolation root", async () => {
    const isolationRoot = mkdtempSync(
      join(tmpdir(), "eliza-caller-owned-isolation-"),
    );
    temporaryDirectories.push(isolationRoot);
    const sentinel = join(isolationRoot, "caller-sentinel");
    writeFileSync(sentinel, "preserve me\n");
    const executable = fixture(`
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage:\\n  eliza [options]\\n\\nOptions:\\n  --help  Show help\\n' ;;
  *) exit 64 ;;
esac
`);

    await expect(
      main([
        "--expected",
        "2.0.0",
        "--isolation-root",
        isolationRoot,
        "--",
        executable,
      ]),
    ).resolves.toBeUndefined();
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n");
    expect(existsSync(isolationRoot)).toBe(true);

    await expect(
      main([
        "--expected",
        "9.9.9",
        "--isolation-root",
        isolationRoot,
        "--",
        executable,
      ]),
    ).rejects.toThrow("version mismatch");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n");
    expect(existsSync(isolationRoot)).toBe(true);
  });

  test("rejects malformed verifier arguments", () => {
    expect(() => parseArguments([])).toThrow("before the packaged command");
    expect(() => parseArguments(["--", "command"])).toThrow(
      "non-empty --expected",
    );
    expect(() => parseArguments(["--expected", "2.0.0", "--"])).toThrow(
      "packaged command",
    );
    expect(() =>
      parseArguments([
        "--expected",
        "2.0.0",
        "--service-timeout-ms",
        "zero",
        "--",
        "command",
      ]),
    ).toThrow("positive integer");
    expect(() =>
      parseArguments(["--unexpected", "value", "--", "command"]),
    ).toThrow("Unknown verifier argument");
  });

  test("rejects a non-loopback service probe", async () => {
    await expect(
      verifyPackagedService({
        command: "command",
        commandArgs: [],
        healthUrl: "https://example.com/api/health",
        serviceArgs: ["serve"],
      }),
    ).rejects.toThrow("loopback HTTP");
  });
});

interface WorkflowStep {
  "continue-on-error"?: boolean | string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  "continue-on-error"?: boolean | string;
  if?: string;
  needs?: string | string[];
  secrets?: string | Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  jobs?: Record<string, WorkflowJob>;
  on?: {
    pull_request?: { paths?: string[] };
    push?: { paths?: string[] };
  };
}

function workflow(path: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(new URL(path, repoRoot), "utf8"),
  ) as Workflow;
}

function stepRun(path: string, job: string, stepName: string): string {
  const step = workflowStep(path, job, stepName);
  if (!step.run) {
    throw new Error(`Missing run body for ${path} ${job} step ${stepName}`);
  }
  return step.run;
}

function workflowStep(
  path: string,
  job: string,
  stepName: string,
): WorkflowStep {
  const step = workflow(path).jobs?.[job]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return step;
}

function stepIndex(path: string, job: string, stepName: string): number {
  const index = workflow(path).jobs?.[job]?.steps?.findIndex(
    (candidate) => candidate.name === stepName,
  );
  if (index === undefined || index < 0) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return index;
}

function expectFailClosedSmoke(
  path: string,
  job: string,
  stepName: string,
): void {
  const step = workflowStep(path, job, stepName);
  const run = stepRun(path, job, stepName);
  expect(run).toContain("verify-packaged-cli.mjs");
  expect(run).toContain("--health-url");
  expect(run).toContain("--service-arg serve");
  expect(run).not.toMatch(/\|\|\s*(?:true|:)/);
  expect(step["continue-on-error"]).not.toBe(true);
}

describe("package workflows", () => {
  const verifierName = "verify-packaged-cli.mjs";

  test("transitive runtime changes trigger every installed-package lane", () => {
    const paths = [
      ".github/workflows/snap-build-test.yml",
      ".github/workflows/test-flatpak.yml",
      ".github/workflows/test-packaging.yml",
    ];
    const runtimeSources = [
      "packages/**",
      "plugins/**",
      "package.json",
      "bun.lock",
      "patches/**",
    ];

    for (const path of paths) {
      const triggers = workflow(path).on;
      for (const source of runtimeSources) {
        expect(triggers?.pull_request?.paths).toContain(source);
        if (triggers?.push) {
          expect(triggers.push.paths).toContain(source);
        }
      }
    }
  });

  test("Snap and Flatpak test workflows use the fail-closed verifier", () => {
    const snapPath = ".github/workflows/snap-build-test.yml";
    const flatpakPath = ".github/workflows/test-flatpak.yml";
    const snapStep = "Install, explicitly connect, and test snap";
    const snap = stepRun(snapPath, "build-snap", snapStep);
    const flatpak = stepRun(flatpakPath, "build", "Install and test");

    expect(snap).toContain(verifierName);
    expect(flatpak).toContain(verifierName);
    expect(snap).toContain("packages/agent/package.json");
    expect(flatpak).toContain("agent/package.json");
    expectFailClosedSmoke(snapPath, "build-snap", snapStep);
    expectFailClosedSmoke(flatpakPath, "build", "Install and test");
    expect(
      workflow(snapPath).jobs?.["build-snap"]?.["continue-on-error"],
    ).toBeUndefined();
  });

  test("Snap packages the same prebuilt runtime closure as other formats", () => {
    const testPath = ".github/workflows/snap-build-test.yml";
    const reusablePath = ".github/workflows/snap-publish.yml";
    const publishPath = ".github/workflows/publish-packages.yml";
    for (const [path, job] of [
      [testPath, "build-snap"],
      [reusablePath, "build-and-publish"],
    ]) {
      const prepare = stepRun(path, job, "Prepare packaged runtime");
      expect(prepare).toContain("prepare-packaged-runtime.mjs");
      expect(prepare).toContain("packaging/snap/runtime");
      expect(stepIndex(path, job, "Prepare packaged runtime")).toBeLessThan(
        stepIndex(path, job, "Build snap"),
      );
    }

    const delegatedPublish = workflow(publishPath).jobs?.["publish-snap"];
    expect(delegatedPublish?.uses).toBe("./.github/workflows/snap-publish.yml");
    expect(delegatedPublish?.secrets).toBe("inherit");
    expect(workflow(reusablePath).concurrency).toEqual({
      group: "snap-publish",
      "cancel-in-progress": false,
    });

    const manifest = readFileSync(
      new URL("packages/app-core/packaging/snap/snapcraft.yaml", repoRoot),
      "utf8",
    );
    expect(manifest).toContain("source: packages/app-core/packaging/snap");
    expect(manifest).not.toContain("bun install");
    expect(manifest).not.toContain('fs.rmSync(path.join("plugins"');
    expect(manifest).not.toContain("workspace:*");
  });

  test("reusable publish jobs verify every installed launcher before publishing", () => {
    const publishPath = ".github/workflows/publish-packages.yml";
    const checks = [
      ["build-deb", "Test .deb package", "Attach .deb to GitHub Release"],
      ["build-flatpak", "Test Flatpak", "Attach Flatpak to GitHub Release"],
    ];

    for (const [job, smoke, publication] of checks) {
      expectFailClosedSmoke(publishPath, job, smoke);
      expect(stepIndex(publishPath, job, smoke)).toBeLessThan(
        stepIndex(publishPath, job, publication),
      );
    }

    const snapPath = ".github/workflows/snap-publish.yml";
    const snapJob = "build-and-publish";
    const snapSmoke = "Install, explicitly connect, and test snap";
    expectFailClosedSmoke(snapPath, snapJob, snapSmoke);
    expect(stepIndex(snapPath, snapJob, snapSmoke)).toBeLessThan(
      stepIndex(snapPath, snapJob, "Publish to Snap Store"),
    );
  });

  test("Debian PR validation installs and boots the built artifact", () => {
    const path = ".github/workflows/test-packaging.yml";
    const prepare = stepRun(path, "build-deb", "Prepare packaged runtime");
    const build = stepRun(path, "build-deb", "Build Debian package");

    expect(prepare).toContain("packaging/debian/runtime");
    expect(build).toContain("dpkg-buildpackage");
    expectFailClosedSmoke(path, "build-deb", "Install and boot Debian package");
    expect(
      stepIndex(path, "build-deb", "Install and boot Debian package"),
    ).toBeLessThan(stepIndex(path, "build-deb", "Upload Debian artifact"));
  });

  test("package artifacts survive failed installed-runtime smoke", () => {
    const uploads = [
      [
        ".github/workflows/snap-build-test.yml",
        "build-snap",
        "Upload snap artifact",
      ],
      [".github/workflows/test-flatpak.yml", "build", "Upload bundle artifact"],
      [
        ".github/workflows/test-packaging.yml",
        "build-deb",
        "Upload Debian artifact",
      ],
      [
        ".github/workflows/snap-publish.yml",
        "build-and-publish",
        "Upload snap artifact",
      ],
      [
        ".github/workflows/publish-packages.yml",
        "build-deb",
        "Upload .deb artifact",
      ],
      [
        ".github/workflows/publish-packages.yml",
        "build-flatpak",
        "Upload Flatpak bundle",
      ],
    ];

    for (const [path, job, step] of uploads) {
      expect(workflowStep(path, job, step).if).toBe("always()");
    }

    // The reusable Debian builder guards its upload on the artifact existing,
    // but must still run it when the installed smoke fails.
    const debUpload = workflowStep(
      ".github/workflows/build-debian-package.yml",
      "build-deb",
      "Upload .deb artifact",
    );
    expect(String(debUpload.if)).toContain("always()");
  });

  test("Flatpak test and release builds prepare the exact source runtime", () => {
    const testPath = ".github/workflows/test-flatpak.yml";
    const publishPath = ".github/workflows/publish-packages.yml";
    const testBuild = stepRun(testPath, "build", "Build agent runtime closure");
    const testPrepare = stepRun(testPath, "build", "Prepare packaged runtime");
    const releaseVersion = stepRun(
      publishPath,
      "build-flatpak",
      "Verify release source version",
    );
    const releaseBuild = stepRun(
      publishPath,
      "build-flatpak",
      "Build agent runtime closure",
    );
    const releasePrepare = stepRun(
      publishPath,
      "build-flatpak",
      "Prepare packaged runtime",
    );

    for (const build of [testBuild, releaseBuild]) {
      expect(build).toContain("--filter=@elizaos/agent...");
    }
    for (const prepare of [testPrepare, releasePrepare]) {
      expect(prepare).toContain("prepare-packaged-runtime.mjs");
      expect(prepare).toContain("@elizaos/agent");
    }
    expect(releaseVersion).toContain("packages/agent/package.json");
    expect(releaseVersion).toContain("npm_version");
  });
});
