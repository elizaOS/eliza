import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLiveRuntimeChildEnv } from "./live-child-env.ts";

const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const DEFAULT_STARTUP_TIMEOUT_MS = 150_000;

export type StartLiveRuntimeServerOptions = {
  env?: Record<string, string | undefined>;
  loggingLevel?: "debug" | "info" | "warn" | "error";
  pluginsAllow?: string[];
  startupTimeoutMs?: number;
  tempPrefix: string;
};

export type RuntimeHarness = {
  close: () => Promise<void>;
  logs: () => string;
  port: number;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(addr.port)));
    });
  });
}

export async function startLiveRuntimeServer(
  options: StartLiveRuntimeServerOptions,
): Promise<RuntimeHarness> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];
  let childExitReason: string | null = null;

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
      logging: { level: options.loggingLevel ?? "warn" },
      plugins: { allow: options.pluginsAllow ?? [] },
    })}\n`,
    "utf8",
  );

  const child = spawn("bun", ["run", "start:eliza"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_API_PORT: String(port),
      ELIZA_PORT: String(port),
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ALLOW_NO_DATABASE: "",
      DISCORD_API_TOKEN: "",
      DISCORD_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "",
      ...options.env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => logBuf.push(chunk));
  child.stderr.on("data", (chunk: string) => logBuf.push(chunk));
  child.once("exit", (code, signal) => {
    childExitReason =
      signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  });

  const deadline =
    Date.now() + (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      break;
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const data = (await response.json()) as {
          ready?: boolean;
          runtime?: string;
        };
        if (data.ready === true && data.runtime === "ok") {
          ready = true;
          break;
        }
      }
    } catch {
      /* not ready */
    }
    await sleep(1_000);
  }

  if (!ready) {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode == null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `Runtime failed to start${
        childExitReason ? ` (${childExitReason})` : ""
      }:\n${logBuf.join("").slice(-8_000)}`,
    );
  }

  return {
    port,
    logs: () => logBuf.join("").slice(-8_000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode == null) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 10_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}
