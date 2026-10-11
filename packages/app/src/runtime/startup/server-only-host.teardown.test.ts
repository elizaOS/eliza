import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shutdownRuntime } from "@elizaos/agent";
import { AgentRuntime, Service } from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerOnlyHost } from "../server-only-process.js";
import { startServerOnlyHost } from "./server-only-host.js";

/** Holds runtime teardown open so a signal can arrive while it runs. */
class SlowStopService extends Service {
  static serviceType = "server_only_teardown_slow_stop";
  capabilityDescription = "Stops after a delay";
  static async start(runtime: AgentRuntime) {
    return new SlowStopService(runtime);
  }
  async stop() {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function startHost() {
  const dir = await mkdtemp(path.join(tmpdir(), "server-only-teardown-"));
  dirs.push(dir);
  const configPath = path.join(dir, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({ agents: { list: [{ id: "main", name: "Eliza" }] } }),
  );
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  // A provider key skips the fresh-install boot deferral.
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-used");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  vi.stubEnv("ELIZA_API_PORT", String(port));
  const runtimes: AgentRuntime[] = [];
  const adapterCloses: number[] = [];
  let host: ServerOnlyHost | undefined;
  await startServerOnlyHost({
    options: {
      onServerOnlyHostReady: (ready) => {
        host = ready;
      },
    },
    bootRuntime: async () => {
      const index = runtimes.length;
      const runtime = new AgentRuntime({
        character: { name: "Eliza", bio: ["test"] },
        plugins: [],
        logLevel: "fatal",
      });
      runtime.setSetting("PGLITE_DATA_DIR", path.join(dir, `pg-${index}`));
      runtime.setSetting("POSTGRES_URL", "");
      installHttpPluginLifecycle(runtime);
      await runtime.registerPlugin(sqlPlugin);
      await runtime.registerPlugin({
        name: "server-only-teardown-slow-stop",
        description: "Holds teardown open",
        services: [SlowStopService as never],
      });
      await runtime.initialize();
      const adapter = runtime.adapter as { close: () => Promise<void> };
      const close = adapter.close.bind(adapter);
      adapterCloses[index] = 0;
      adapter.close = async () => {
        adapterCloses[index] += 1;
        await close();
      };
      runtimes.push(runtime);
      return runtime;
    },
    stopRuntime: (runtime, reason, options) =>
      shutdownRuntime(runtime, reason, options),
    stopWithoutRuntime: () => {},
  });
  if (!host) throw new Error("server-only host did not start");
  const post = (action: "restart" | "stop") =>
    fetch(`http://127.0.0.1:${port}/api/agent/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  return { host, post, runtimes, adapterCloses };
}

it.each(["stop", "restart"] as const)(
  "closes the original adapter once when a signal arrives during an API %s",
  async (action) => {
    const { host, post, runtimes, adapterCloses } = await startHost();
    const request = post(action);
    // The teardown is now inside the slow service stop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await host.close();
    // The signal path returned only after the original adapter closed.
    expect(adapterCloses[0]).toBe(1);
    await request;
    for (const runtime of runtimes.slice(1)) {
      await shutdownRuntime(runtime, "server-only teardown test cleanup", {
        fast: true,
      });
    }
    expect(adapterCloses[0]).toBe(1);
  },
  60_000,
);
