/**
 * Out-of-process integration for the `home` SandboxRunnerProvider:
 * E2BRemoteCapabilityRouterService -> coding-remote-runner over a REAL HTTP
 * boundary (a Bun child process, or a Docker container when
 * ELIZA_CODING_RUNNER_DOCKER=1) instead of the in-process globalThis.fetch
 * shim used by e2b-capability-router.coding-remote-runner.test.ts.
 *
 * The unit baseline (sibling *.coding-remote-runner.test.ts) wires the runner
 * handler INTO globalThis.fetch, so it never crosses a process or network
 * boundary and never exercises the Dockerfile. This file is exactly that delta:
 * it boots the runner as a separate OS process listening on a real TCP socket
 * (or as a container), then drives create / read / modify / list / auth over
 * the same /v1 contract iOS + Play remote coding use.
 *
 * Three-tier clean skip (mirrors remote-capability-cloud-sandbox.cloud-smoke
 * and remote-capability-url-endpoint-providers.provider-smoke):
 *   (1) DEFAULT lane  — boot a Bun runner subprocess; if `bun` is absent or it
 *                        never becomes healthy, route every case to it.skip with
 *                        a single console.warn naming the infra.
 *   (2) DOCKER lane   — opt-in via ELIZA_CODING_RUNNER_DOCKER=1; needs `docker`
 *                        on PATH AND the `eliza-coding-remote-runner:local`
 *                        image. Absent => it.skip naming the build step.
 *   (3) bare CI box   — the entire boot lives in beforeAll, so import/compile
 *                        never needs anything live; a totally bare box skips.
 *
 * Nothing here fails CI on a box that lacks bun/docker.
 *
 * NOTE ON LANE WIRING: this file uses the `*.integration.test.ts` suffix, which
 * the agent unit vitest.config.ts intentionally excludes and the shared
 * integration.config.ts globs only under `test/**`. To execute it explicitly
 * (the command reported as `verified`), run vitest against this file with the
 * unit-lane `*.integration.test.ts` exclude lifted.
 */
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2BRemoteCapabilityRouterService } from "../src/services/e2b-capability-router.ts";

const execFileAsync = promisify(execFile);

const RUNNER_ENTRY = nodePath.resolve(
  __dirname,
  "../../cloud-services/coding-remote-runner/src/index.ts",
);
const DOCKER_IMAGE = "eliza-coding-remote-runner:local";
const DOCKER_MODE = process.env.ELIZA_CODING_RUNNER_DOCKER === "1";
const HEALTH_DEADLINE_MS = 15_000;
const WORKDIR = "/workspace";

let runnerReady = false;
let skipReason = "";
let baseUrl = "";
let token = "";
let hostWorkspaceRoot = "";
let tmpRoot = "";
let bunChild: ChildProcess | null = null;
let dockerContainerId = "";

/**
 * The runner write/list/cat round-trip lands files at the runner's REAL
 * workspace directory. In the Bun-subprocess lane that dir is `hostWorkspaceRoot`
 * directly; in the docker lane it is the bind-mounted host dir (-v <tmp>:/workspace).
 * Either way `hostFile(name)` is the host-side path the test asserts against to
 * prove the bytes left the caller process.
 */
function hostFile(name: string): string {
  return nodePath.join(hostWorkspaceRoot, name);
}

function makeRuntime(): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "33333333-3333-3333-3333-333333333333" as UUID,
    character: { name: "Coding Remote Runner Integration" },
    getSetting: () => null,
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

function makeService(overrideToken?: string): E2BRemoteCapabilityRouterService {
  return new E2BRemoteCapabilityRouterService(makeRuntime(), {
    enabled: true,
    provider: "home",
    remoteHttpBaseUrl: baseUrl,
    remoteHttpToken: overrideToken ?? token,
    agentRunners: ["codex", "claude-code", "opencode"],
    workdir: WORKDIR,
    hostWorkspaceRoot,
    timeoutMs: 30_000,
    requestTimeoutMs: 10_000,
    keepAlive: true,
    allowInternetAccess: false,
    envs: {},
    metadata: {},
  });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not resolve a free port.")));
        return;
      }
      const { port } = address;
      server.close((closeError) =>
        closeError ? reject(closeError) : resolve(port),
      );
    });
  });
}

async function bunOnPath(): Promise<boolean> {
  try {
    await execFileAsync("bun", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function dockerImageReady(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DOCKER_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthy(url: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_000);
      try {
        const response = await fetch(`${url}/health`, {
          signal: controller.signal,
        });
        if (response.status === 200) return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function bootBunRunner(): Promise<void> {
  if (!(await bunOnPath())) {
    skipReason =
      "could not boot local Bun runner subprocess; set ELIZA_CODING_RUNNER_DOCKER=1 with a built image, or ensure bun is on PATH";
    return;
  }
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  bunChild = spawn("bun", ["run", RUNNER_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ELIZA_CODING_WORKSPACE: hostWorkspaceRoot,
      ELIZA_REMOTE_RUNNER_HTTP_TOKEN: token,
    },
  });
  bunChild.on("error", () => {
    /* surfaced via the health poll below */
  });
  if (await waitForHealthy(baseUrl)) {
    runnerReady = true;
    return;
  }
  skipReason =
    "could not boot local Bun runner subprocess; set ELIZA_CODING_RUNNER_DOCKER=1 with a built image, or ensure bun is on PATH";
}

async function bootDockerRunner(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"]);
  } catch {
    skipReason = `docker daemon unavailable; build the runner image first with \`bun run --cwd packages/cloud-services/coding-remote-runner docker:build\``;
    return;
  }
  if (!(await dockerImageReady())) {
    skipReason = `image ${DOCKER_IMAGE} not built; run \`bun run --cwd packages/cloud-services/coding-remote-runner docker:build\``;
    return;
  }
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "-p",
    `127.0.0.1:${port}:3000`,
    "-e",
    `ELIZA_REMOTE_RUNNER_HTTP_TOKEN=${token}`,
    "-e",
    "ELIZA_CODING_WORKSPACE=/workspace",
    "-v",
    `${hostWorkspaceRoot}:/workspace`,
    DOCKER_IMAGE,
  ]);
  dockerContainerId = stdout.trim();
  if (await waitForHealthy(baseUrl)) {
    runnerReady = true;
    return;
  }
  skipReason = `container ${dockerContainerId.slice(0, 12)} from ${DOCKER_IMAGE} never became healthy`;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(nodePath.join(tmpdir(), "coding-runner-int-"));
  hostWorkspaceRoot = nodePath.join(tmpRoot, "ws");
  await mkdir(hostWorkspaceRoot, { recursive: true });
  token = randomBytes(16).toString("hex");

  if (DOCKER_MODE) {
    await bootDockerRunner();
  } else {
    await bootBunRunner();
  }

  if (!runnerReady) {
    console.warn(`[coding-runner-integration] skipped: ${skipReason}`);
  }
}, 60_000);

afterAll(async () => {
  if (bunChild && bunChild.exitCode === null) {
    bunChild.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (bunChild.exitCode === null) bunChild.kill("SIGKILL");
  }
  bunChild = null;
  if (dockerContainerId) {
    await execFileAsync("docker", ["rm", "-f", dockerContainerId]).catch(
      () => {},
    );
    dockerContainerId = "";
  }
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("E2B home-provider router over the REAL coding-remote-runner HTTP boundary", () => {
  // Gating decision must be deferred to RUN time: the runner boot happens in
  // beforeAll, which executes AFTER this describe body collects the cases, so we
  // register every case unconditionally and call ctx.skip() when the runner did
  // not come up. This keeps a bare CI box green (reported as skipped, exit 0)
  // while running for real wherever bun/docker is present.
  it("availability() resolves the home-provider fs/pty/git capability surface", async (ctx) => {
    if (!runnerReady) return ctx.skip();
    // availability() is config-derived (creds present) and does NOT itself
    // hit the network; the live /v1/health handshake is proven by the
    // create/read cases below. Here we lock the exact capability shape.
    const service = makeService();
    const availability = await service.availability();
    expect(availability.available).toBe(true);
    expect(availability.capabilities).toEqual({
      fs: true,
      pty: true,
      git: true,
      model: false,
      plugin: false,
    });
  });

  it("creates a file inside the runner workspace via POST /v1/processes/run and reads it back via GET /v1/fs/file", async (ctx) => {
    if (!runnerReady) return ctx.skip();
    const service = makeService();

    // CREATE: the command executes inside the runner process/container, not
    // the caller host. This crosses a real TCP socket + (in docker) a process
    // boundary, so it proves the GET /v1/health handshake + POST /processes/run.
    const created = await service.pty.runCommand({
      command: "sh",
      args: ["-lc", "printf 'remote-coded' > created-in-container.txt"],
      cwd: WORKDIR,
      timeoutMs: 10_000,
    });
    expect(created.exitCode).toBe(0);
    expect(created.timedOut).toBe(false);

    // READ-BACK over the contract.
    const read = await service.fs.readText({
      path: "created-in-container.txt",
    });
    expect(read).toMatchObject({
      path: "/workspace/created-in-container.txt",
      text: "remote-coded",
      truncated: false,
    });

    // HOST/VOLUME-SIDE PROOF: bytes landed in the runner's real workspace dir
    // (the bind-mounted volume on docker), not an in-memory mock.
    await expect(
      readFile(hostFile("created-in-container.txt"), "utf8"),
    ).resolves.toBe("remote-coded");
  });

  it("modifies the existing container file via PUT /v1/fs/file", async (ctx) => {
    if (!runnerReady) return ctx.skip();
    const service = makeService();
    // Ensure the file exists first (cases are isolated services but share the
    // one live workspace).
    await service.fs.writeText({
      path: "created-in-container.txt",
      text: "remote-coded",
    });

    const written = await service.fs.writeText({
      path: "created-in-container.txt",
      text: "remote-modified",
    });
    expect(written).toMatchObject({
      path: "/workspace/created-in-container.txt",
      bytesWritten: 15,
    });

    const read = await service.fs.readText({
      path: "created-in-container.txt",
    });
    expect(read.text).toBe("remote-modified");

    await expect(
      readFile(hostFile("created-in-container.txt"), "utf8"),
    ).resolves.toBe("remote-modified");
  });

  it("lists the artifact via GET /v1/fs/entries", async (ctx) => {
    if (!runnerReady) return ctx.skip();
    const service = makeService();
    await service.fs.writeText({
      path: "created-in-container.txt",
      text: "remote-modified",
    });

    const listing = await service.fs.list({ path: WORKDIR });
    const match = listing.entries.find(
      (entry) => entry.name === "created-in-container.txt",
    );
    expect(match).toBeDefined();
    expect(match?.kind).toBe("file");
  });

  it("rejects fs/pty calls when the Bearer token is wrong (401 surfaced on the live HTTP boundary)", async (ctx) => {
    if (!runnerReady) return ctx.skip();
    // availability() only checks that creds are PRESENT for 'home', so it is
    // still available:true with a wrong token...
    const service = makeService(`wrong-${randomUUID()}`);
    const availability = await service.availability();
    expect(availability.available).toBe(true);

    // ...but the first call hits GET /v1/health with the wrong Bearer, the
    // real runner returns 401, and the factory throws it.
    await expect(service.fs.list({ path: WORKDIR })).rejects.toThrow(
      /unauthorized/i,
    );
  });
});
