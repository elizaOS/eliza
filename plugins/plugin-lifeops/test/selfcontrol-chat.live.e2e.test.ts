import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../../../packages/app-core/test/helpers/conditional-tests.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../../../packages/app-core/test/helpers/http";
import { createLiveRuntimeChildEnv } from "../../../packages/app-core/test/helpers/live-child-env.ts";
import { selectLiveProvider } from "../../../packages/app-core/test/helpers/live-provider.ts";
import { stochasticTest } from "../../../packages/app-core/test/helpers/stochastic-test";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");

try {
  const { config } = await import("dotenv");
  config({ path: ENV_PATH });
} catch {
  // dotenv is optional in this test environment.
}

const selectedLiveProvider = selectLiveProvider();
const selectedLiveProviderPlugin = selectedLiveProvider?.pluginPackage ?? null;
const liveSelfcontrolChatEnabled =
  LIVE_TESTS_ENABLED &&
  Boolean(selectedLiveProvider) &&
  Boolean(selectedLiveProviderPlugin);

type StartedRuntime = {
  close: () => Promise<void>;
  getLogTail: () => string;
  hostsFilePath: string;
  port: number;
};

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("close", handleExit);
    };

    child.once("exit", handleExit);
    child.once("close", handleExit);
  });
}

async function waitForJsonPredicate<T>(
  url: string,
  predicate: (value: T) => boolean,
  timeoutMs: number = 150_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`);
      }

      const data = (await response.json()) as T;
      if (predicate(data)) {
        return data;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function waitForHostsBlock(
  hostsFilePath: string,
  websites: string[],
  timeoutMs: number = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hosts = await readFile(hostsFilePath, "utf8");
    if (websites.every((website) => hosts.includes(website))) {
      return hosts;
    }
    await sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for hosts file block: ${websites.join(", ")}`,
  );
}

async function waitForWebsiteBlockStatus(
  runtime: StartedRuntime,
  websites: string[],
  timeoutMs: number = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: unknown = null;

  while (Date.now() < deadline) {
    const response = await req(runtime.port, "GET", "/api/website-blocker");
    lastStatus = response.data;
    const data =
      response.data && typeof response.data === "object"
        ? (response.data as {
            active?: unknown;
            websites?: unknown;
          })
        : null;
    const active = data?.active === true;
    const blockedWebsites = Array.isArray(data?.websites)
      ? data.websites.filter(
          (website): website is string => typeof website === "string",
        )
      : [];

    if (
      active &&
      websites.every((website) => blockedWebsites.includes(website))
    ) {
      return response.data as Record<string, unknown>;
    }

    await sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for website blocker status: ${websites.join(", ")}\nstatus=${JSON.stringify(lastStatus)}\n${runtime.getLogTail()}`,
  );
}

async function startLiveRuntime(options?: {
  includeProviderPlugin?: boolean;
}): Promise<StartedRuntime> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-selfcontrol-"));
  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(tempRoot, "eliza.json");
  const hostsFilePath = path.join(tempRoot, "hosts");
  const apiPort = await getFreePort();
  const logs: string[] = [];
  const allowPlugins = ["selfcontrol"];

  if (options?.includeProviderPlugin && selectedLiveProviderPlugin) {
    allowPlugins.push(selectedLiveProviderPlugin);
  }

  await mkdir(stateDir, { recursive: true });
  await writeFile(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        logging: { level: "info" },
        plugins: {
          allow: allowPlugins,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ...(selectedLiveProvider?.env ?? {}),
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(apiPort),
      ELIZA_API_PORT: String(apiPort),
      WEBSITE_BLOCKER_HOSTS_FILE_PATH: hostsFilePath,
      SELFCONTROL_HOSTS_FILE_PATH: hostsFilePath,
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ALLOW_NO_DATABASE: "",
      DISCORD_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => logs.push(chunk));
  child.stderr.on("data", (chunk: string) => logs.push(chunk));

  try {
    await waitForJsonPredicate<{ ready?: boolean; runtime?: string }>(
      `http://127.0.0.1:${apiPort}/api/health`,
      (value) => value.ready === true && value.runtime === "ok",
    );
  } catch (error) {
    const logTail = logs.join("").slice(-8_000);
    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5_000);
    }
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      `Live runtime failed to start: ${error instanceof Error ? error.message : String(error)}\n${logTail}`,
    );
  }

  return {
    getLogTail: () => logs.join("").slice(-8_000),
    hostsFilePath,
    port: apiPort,
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        const exited = await waitForChildExit(child, 10_000);
        if (!exited && child.exitCode == null) {
          child.kill("SIGKILL");
          await waitForChildExit(child, 5_000);
        }
      }

      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function runChatContextWebsiteBlockFlow(
  runtime: StartedRuntime,
): Promise<void> {
  const pluginsResponse = await req(runtime.port, "GET", "/api/plugins");
  expect(pluginsResponse.status).toBe(200);

  const { conversationId } = await createConversation(runtime.port, {
    title: "Live SelfControl",
  });

  const firstTurn = await postConversationMessage(
    runtime.port,
    conversationId,
    {
      text: "The websites distracting me are x.com and twitter.com. Do not block them yet.",
    },
  );
  expect(firstTurn.status).toBe(200);
  assertNoProviderIssue(
    "first turn",
    String(firstTurn.data.text ?? ""),
    runtime,
  );
  expect(await readFile(runtime.hostsFilePath, "utf8")).toBe(
    "127.0.0.1 localhost\n",
  );
  const firstTurnStatus = await req(
    runtime.port,
    "GET",
    "/api/website-blocker",
  );
  expect(firstTurnStatus.status).toBe(200);
  expect(firstTurnStatus.data).toMatchObject({
    active: false,
    websites: [],
  });

  const secondTurn = await postConversationMessage(
    runtime.port,
    conversationId,
    {
      text: "Use self control now. Actually block the websites for 1 minute instead of giving advice.",
    },
  );
  expect(secondTurn.status).toBe(200);

  const secondText = String(secondTurn.data.text ?? "");
  assertNoProviderIssue("second turn", secondText, runtime);
  expect(secondText).not.toMatch(
    /Provide at least one public website hostname/i,
  );

  const status = await waitForWebsiteBlockStatus(runtime, [
    "x.com",
    "twitter.com",
  ]);
  expect(status).toMatchObject({
    active: true,
    websites: expect.arrayContaining(["x.com", "twitter.com"]),
  });
  const hosts = await waitForHostsBlock(runtime.hostsFilePath, [
    "x.com",
    "twitter.com",
    "api.x.com",
  ]);
  expect(hosts).toContain("x.com");
  expect(hosts).toContain("twitter.com");
  expect(hosts).toContain("api.x.com");
}

function assertNoProviderIssue(
  turnName: string,
  text: string,
  runtime: StartedRuntime,
): void {
  if (!/provider issue/i.test(text)) {
    return;
  }

  throw new Error(
    `${turnName} returned a provider issue reply.\n${runtime.getLogTail()}`,
  );
}

describeIf(LIVE_TESTS_ENABLED)("Live: website blocker API roundtrip", () => {
  let runtime: StartedRuntime | undefined;

  beforeAll(async () => {
    runtime = await startLiveRuntime({
      includeProviderPlugin: Boolean(selectedLiveProviderPlugin),
    });
  }, 120_000);

  afterAll(async () => {
    if (runtime) {
      await runtime.close();
    }
  });

  it("blocks and unblocks websites through the real runtime API", async () => {
    const startResponse = await req(
      runtime.port,
      "PUT",
      "/api/website-blocker",
      {
        websites: ["x.com", "twitter.com"],
        durationMinutes: 1,
      },
    );
    expect(startResponse.status).toBe(200);
    expect(startResponse.data).toMatchObject({
      success: true,
      request: {
        websites: ["x.com", "twitter.com"],
        durationMinutes: 1,
      },
    });

    // Startup smoke should verify the runtime contract only. Dedicated dev
    // and service tests already cover the concrete hosts-file mutation path.
    const statusResponse = await waitForWebsiteBlockStatus(runtime, [
      "x.com",
      "twitter.com",
    ]);
    expect(statusResponse).toMatchObject({
      active: true,
      engine: "hosts-file",
      requiresElevation: false,
      websites: ["x.com", "twitter.com"],
    });

    const stopResponse = await req(
      runtime.port,
      "DELETE",
      "/api/website-blocker",
    );
    expect(stopResponse.status).toBe(200);
    expect(stopResponse.data).toMatchObject({
      success: true,
      status: {
        active: false,
      },
    });
    expect(stopResponse.data.removed).toEqual(expect.any(Boolean));
  }, 180_000);
});

describeIf(liveSelfcontrolChatEnabled)(
  "Live: website blocker chat roundtrip",
  () => {
    describe("strict single-attempt", () => {
      it("uses prior chat context to block websites through the real runtime on the first attempt", async () => {
        const runtime = await startLiveRuntime({
          includeProviderPlugin: true,
        });
        try {
          await runChatContextWebsiteBlockFlow(runtime);
        } finally {
          await runtime.close();
        }
      }, 180_000);
    });

    describe("stability coverage", () => {
      stochasticTest(
        "uses prior chat context to block websites through the real runtime",
        async () => {
          const runtime = await startLiveRuntime({
            includeProviderPlugin: true,
          });
          try {
            await runChatContextWebsiteBlockFlow(runtime);
          } finally {
            await runtime.close();
          }
        },
        {
          perRunTimeoutMs: 180_000,
          label: "selfcontrol-chat/block-after-context",
        },
      );
    });
  },
);
