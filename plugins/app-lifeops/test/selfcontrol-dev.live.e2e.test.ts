import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { req } from "../../../test/helpers/http";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

type StartedDevStack = {
  apiPort: number;
  close: () => Promise<void>;
  getLogTail: () => string;
  hostsFilePath: string;
  uiPort: number;
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
  timeoutMs = 180_000,
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

async function waitForTextPredicate(
  url: string,
  predicate: (text: string) => boolean,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`);
      }

      const text = await response.text();
      if (predicate(text)) {
        return text;
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
  timeoutMs = 60_000,
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

async function removeTempRoot(tempRoot: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as NodeJS.ErrnoException).code ?? "")
          : "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) {
        throw error;
      }
    }

    await sleep(250);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out removing temp directory: ${tempRoot}`);
}

async function startDevStack(): Promise<StartedDevStack> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-dev-stack-"));
  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(tempRoot, "eliza.json");
  const hostsFilePath = path.join(tempRoot, "hosts");
  const apiPort = await getFreePort();
  const uiPort = await getFreePort();
  const logs: string[] = [];

  await mkdir(stateDir, { recursive: true });
  await writeFile(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        logging: { level: "info" },
        plugins: {
          allow: ["selfcontrol"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = spawn("bun", ["run", "dev"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CI: "1",
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_DEV_ONCHAIN: "0",
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      ALLOW_NO_DATABASE: "",
      SELFCONTROL_HOSTS_FILE_PATH: hostsFilePath,
      WEBSITE_BLOCKER_HOSTS_FILE_PATH: hostsFilePath,
    },
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
    await waitForTextPredicate(
      `http://127.0.0.1:${uiPort}`,
      (text) =>
        text.includes('<div id="root">') || text.includes("<!doctype html>"),
    );
  } catch (error) {
    const logTail = logs.join("").slice(-12_000);
    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5_000);
    }
    await removeTempRoot(tempRoot);
    throw new Error(
      `Dev stack failed to start: ${error instanceof Error ? error.message : String(error)}\n${logTail}`,
    );
  }

  return {
    apiPort,
    getLogTail: () => logs.join("").slice(-12_000),
    hostsFilePath,
    uiPort,
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        const exited = await waitForChildExit(child, 10_000);
        if (!exited && child.exitCode == null) {
          child.kill("SIGKILL");
          await waitForChildExit(child, 5_000);
        }
      }

      await removeTempRoot(tempRoot);
    },
  };
}

describeIf(LIVE_TESTS_ENABLED)("Live: website blocker dev launcher", () => {
  let stack: StartedDevStack | undefined;

  beforeAll(async () => {
    stack = await startDevStack();
  }, 240_000);

  afterAll(async () => {
    if (stack) {
      await stack.close();
    }
  });

  it("boots bun run dev with website blocker APIs and UI available", async () => {
    const uiResponse = await fetch(`http://127.0.0.1:${stack.uiPort}`);
    expect(uiResponse.ok).toBe(true);

    const permissionResponse = await req(
      stack.apiPort,
      "GET",
      "/api/permissions/website-blocking",
    );
    expect(permissionResponse.status).toBe(200);
    expect(permissionResponse.data).toMatchObject({
      id: "website-blocking",
      status: "granted",
      canRequest: false,
    });

    const cleanupResponse = await req(
      stack.apiPort,
      "DELETE",
      "/api/website-blocker",
    );
    expect(cleanupResponse.status).toBe(200);

    try {
      const startResponse = await req(
        stack.apiPort,
        "PUT",
        "/api/website-blocker",
        {
          websites: ["x.com", "twitter.com"],
          durationMinutes: 5,
        },
      );
      expect(startResponse.status).toBe(200);
      expect(startResponse.data).toMatchObject({
        success: true,
        request: {
          websites: ["x.com", "twitter.com"],
          durationMinutes: 5,
        },
      });

      const hosts = await waitForHostsBlock(stack.hostsFilePath, [
        "x.com",
        "twitter.com",
      ]);
      expect(hosts).toContain("0.0.0.0 x.com");
      expect(hosts).toContain("0.0.0.0 twitter.com");
      expect(hosts).not.toContain("0.0.0.0 api.x.com");
      expect(hosts).not.toContain("0.0.0.0 api.twitter.com");
    } finally {
      const stopResponse = await req(
        stack.apiPort,
        "DELETE",
        "/api/website-blocker",
      );
      expect(stopResponse.status).toBe(200);
      expect(stopResponse.data).toMatchObject({
        success: true,
        status: {
          active: false,
          websites: [],
        },
      });
      expect(await readFile(stack.hostsFilePath, "utf8")).toBe(
        "127.0.0.1 localhost\n",
      );
    }
  }, 240_000);
});
