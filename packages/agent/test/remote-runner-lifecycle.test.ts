/** Real child-process HTTP runner: shutdown fences creation and drains accepted writes. */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { RemoteCodingCapabilityRouterService } from "../src/services/remote-coding-runner.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type RunnerMessage = { type: string; port?: number };

async function fixture(gate: "health" | "write") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "remote-runner-lifecycle-"),
  );
  const messages: RunnerMessage[] = [];
  const subscribers = new Set<(message: RunnerMessage) => void>();
  const child: ChildProcess = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "./fixtures/remote-runner-lifecycle-child.mjs",
          import.meta.url,
        ),
      ),
      directory,
      gate,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    const message = value as RunnerMessage;
    messages.push(message);
    for (const subscriber of subscribers) subscriber(message);
  });
  function waitFor(type: string): Promise<RunnerMessage> {
    const existing = messages.find((message) => message.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscribers.delete(listener);
        reject(new Error(`Runner did not send ${type}: ${stderr}`));
      }, 10_000);
      const listener = (message: RunnerMessage) => {
        if (message.type !== type) return;
        clearTimeout(timer);
        subscribers.delete(listener);
        resolve(message);
      };
      subscribers.add(listener);
    });
  }
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await waitFor("ready");
  if (!ready.port) throw new Error("Runner did not publish a port");
  const runtime = new AgentRuntime({
    character: { name: "Runner lifecycle", bio: [], settings: {} },
    logLevel: "fatal",
  });
  const service = new RemoteCodingCapabilityRouterService(runtime, {
    enabled: true,
    provider: "home",
    remoteHttpBaseUrl: `http://127.0.0.1:${ready.port}`,
    agentRunners: [],
    workdir: "/workspace",
    hostWorkspaceRoot: directory,
    timeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    keepAlive: false,
    allowInternetAccess: false,
    envs: {},
    metadata: {},
  });
  cleanups.push(async () => {
    child.send?.({ type: "release-all" });
    await service.stop();
  });
  return { service, child, directory, messages, waitFor };
}

it("rejects a creation racing shutdown and never recreates the runner after stop", async () => {
  const h = await fixture("health");
  const writing = h.service.fs.writeText({
    path: path.join(h.directory, "late.txt"),
    text: "must not be written",
  });
  const rejected = expect(writing).rejects.toMatchObject({
    code: "REMOTE_CODING_RUNNER_STOPPED",
  });
  await h.waitFor("health");
  const stopping = h.service.stop();
  h.child.send({ type: "release-health" });
  await Promise.all([rejected, stopping]);
  await expect(
    h.service.fs.writeText({
      path: path.join(h.directory, "later.txt"),
      text: "must not recreate",
    }),
  ).rejects.toMatchObject({ code: "REMOTE_CODING_RUNNER_STOPPED" });
  expect(
    h.messages.filter((message) => message.type === "health"),
  ).toHaveLength(1);
  expect(h.messages.some((message) => message.type === "write-received")).toBe(
    false,
  );
  await expect(
    readFile(path.join(h.directory, "late.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for an already dispatched write before shutdown completes", async () => {
  const h = await fixture("write");
  const file = path.join(h.directory, "accepted.txt");
  const writing = h.service.fs.writeText({
    path: file,
    text: "complete accepted effect",
  });
  await h.waitFor("write-received");
  let stopped = false;
  const stopping = h.service.stop().then(() => {
    stopped = true;
  });
  h.child.send({ type: "ping" });
  await h.waitFor("pong");
  expect(stopped).toBe(false);
  h.child.send({ type: "release-write" });
  await Promise.all([writing, stopping]);
  expect(await readFile(file, "utf8")).toBe("complete accepted effect");
  expect(
    h.messages.filter((message) => message.type === "write-committed"),
  ).toHaveLength(1);
  await expect(
    h.service.fs.writeText({ path: file, text: "late replacement" }),
  ).rejects.toMatchObject({ code: "REMOTE_CODING_RUNNER_STOPPED" });
  expect(await readFile(file, "utf8")).toBe("complete accepted effect");
});
