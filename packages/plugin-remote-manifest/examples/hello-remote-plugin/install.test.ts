import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installPrebuiltRemotePlugin, loadInstalledRemotePlugin } from "../../src/store.js";

const HELLO_REMOTE_PLUGIN_DIR = resolve(import.meta.dir);

interface ActionMessage {
  type: "action";
  action: string;
  payload?: { level?: string; message?: string };
}

interface ReadyMessage {
  type: "ready";
}

type WorkerLifeMessage = ActionMessage | ReadyMessage;

describe("hello-remote-plugin example", () => {
  it("manifest validates, installs, and wires bootstrap end-to-end", () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "hello-remote-plugin-"));
    try {
      const installed = installPrebuiltRemotePlugin(storeRoot, HELLO_REMOTE_PLUGIN_DIR, {
        devMode: true,
      });

      expect(installed.manifest.id).toBe("hello-remote-plugin");
      expect(installed.manifest.mode).toBe("background");
      expect(existsSync(installed.workerPath)).toBe(true);
      expect(installed.workerPath).toContain(
        ".bunny/plugin-bun-entrypoint.mjs",
      );

      const bootstrap = readFileSync(installed.workerPath, "utf8");
      expect(bootstrap).toContain("__remotePluginBootstrap");
      expect(bootstrap).toContain('"id":"hello-remote-plugin"');
      expect(bootstrap).toContain('"channel":"remote-plugin:hello-remote-plugin"');
      expect(bootstrap).toContain("await import");

      const reloaded = loadInstalledRemotePlugin(storeRoot, "hello-remote-plugin");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.viewUrl).toBe("views://view/index.html");
      if (!reloaded) throw new Error("Expected hello-remote-plugin to reload.");
      expect(dirname(reloaded.bundleWorkerPath)).toBe(installed.currentDir);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("boots in a real Bun Worker and writes the expected side effects", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "hello-remote-plugin-boot-"));
    try {
      const installed = installPrebuiltRemotePlugin(storeRoot, HELLO_REMOTE_PLUGIN_DIR, {
        devMode: true,
      });

      const workerUrl = pathToFileURL(installed.workerPath).href;
      const worker = new Worker(workerUrl, { type: "module" });
      const messages: WorkerLifeMessage[] = [];

      await new Promise<void>((resolveReady, rejectFailed) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          rejectFailed(new Error("hello-remote-plugin did not emit ready within 2s"));
        }, 2000);
        worker.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as WorkerLifeMessage;
          messages.push(data);
          if (data.type === "ready") {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          rejectFailed(
            new Error(`worker error: ${event.message ?? "unknown"}`),
          );
        });
      });

      worker.terminate();

      const stateDir = installed.stateDir;
      const statePath = join(stateDir, "state.json");
      const logsPath = join(stateDir, "logs.txt");

      expect(existsSync(statePath)).toBe(true);
      const stateText = readFileSync(statePath, "utf8");
      expect(stateText).toContain('"remotePluginId": "hello-remote-plugin"');
      expect(stateText).toContain('"bootedAt"');

      expect(existsSync(logsPath)).toBe(true);
      const logsText = readFileSync(logsPath, "utf8");
      expect(logsText).toContain("hello-remote-plugin booted");
      expect(logsText).toContain("channel=remote-plugin:hello-remote-plugin");

      const actionLogs = messages.filter(
        (m): m is ActionMessage => m.type === "action" && m.action === "log",
      );
      expect(actionLogs).toHaveLength(1);
      expect(actionLogs[0].payload?.level).toBe("info");
      expect(actionLogs[0].payload?.message).toContain("hello-remote-plugin ready");

      const readyMessages = messages.filter((m) => m.type === "ready");
      expect(readyMessages).toHaveLength(1);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
