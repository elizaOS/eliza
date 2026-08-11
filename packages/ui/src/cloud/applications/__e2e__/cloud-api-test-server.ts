/**
 * Starts the real local Cloud API on an operating-system-assigned loopback port
 * and returns the address reported by the listening process.
 */

import { type ChildProcess, spawn } from "node:child_process";

const LISTENING_PATTERN =
  /\[cloud-api-hono-dev\] listening on (http:\/\/127\.0\.0\.1:\d+)/;

export async function startCloudApiTestServer(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ child: ChildProcess; baseUrl: string }> {
  const child = spawn(
    "bun",
    ["run", "packages/cloud/scripts/admin/dev/cloud-api-hono-dev.ts"],
    {
      cwd: options.repoRoot,
      env: {
        ...options.env,
        API_DEV_HOST: "127.0.0.1",
        API_DEV_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(
      () =>
        finish(
          null,
          new Error(
            `cloud-api-hono-dev did not report its listening address within ${options.timeoutMs ?? 120_000}ms`,
          ),
        ),
      options.timeoutMs ?? 120_000,
    );

    const finish = (baseUrl: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        child.kill("SIGTERM");
        reject(error);
        return;
      }
      if (baseUrl === null) {
        reject(
          new Error("cloud-api-hono-dev reported an invalid listening address"),
        );
        return;
      }
      resolve(baseUrl);
    };
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
      const match = LISTENING_PATTERN.exec(output);
      if (match) finish(match[1]);
    };
    const onError = (error: Error) => finish(null, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        null,
        new Error(
          `cloud-api-hono-dev exited before listening (code ${code}, signal ${signal})`,
        ),
      );

    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return { child, baseUrl };
}
