import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installPrebuiltCarrot,
  loadInstalledCarrot,
} from "../../src/store.js";

const HELLO_CARROT_DIR = resolve(import.meta.dir);

interface ActionMessage {
  type: "action";
  action: string;
  payload?: { level?: string; message?: string };
}

interface ReadyMessage {
  type: "ready";
}

type WorkerLifeMessage = ActionMessage | ReadyMessage;

describe("hello-carrot example", () => {
  it("manifest validates, installs, and wires bootstrap end-to-end", () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "hello-carrot-"));
    try {
      const installed = installPrebuiltCarrot(storeRoot, HELLO_CARROT_DIR, {
        devMode: true,
      });

      expect(installed.manifest.id).toBe("hello-carrot");
      expect(installed.manifest.mode).toBe("background");
      expect(existsSync(installed.workerPath)).toBe(true);
      expect(installed.workerPath).toContain(".bunny/carrot-bun-entrypoint.mjs");

      const bootstrap = readFileSync(installed.workerPath, "utf8");
      expect(bootstrap).toContain("__bunnyCarrotBootstrap");
      expect(bootstrap).toContain('"id":"hello-carrot"');
      expect(bootstrap).toContain('"channel":"carrot:hello-carrot"');
      expect(bootstrap).toContain("await import");

      const reloaded = loadInstalledCarrot(storeRoot, "hello-carrot");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.viewUrl).toBe("views://view/index.html");
      expect(dirname(reloaded!.bundleWorkerPath)).toBe(installed.currentDir);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("boots in a real Bun Worker and writes the expected side effects", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "hello-carrot-boot-"));
    try {
      const installed = installPrebuiltCarrot(storeRoot, HELLO_CARROT_DIR, {
        devMode: true,
      });

      const workerUrl = pathToFileURL(installed.workerPath).href;
      const worker = new Worker(workerUrl, { type: "module" });
      const messages: WorkerLifeMessage[] = [];

      await new Promise<void>((resolveReady, rejectFailed) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          rejectFailed(new Error("hello-carrot did not emit ready within 2s"));
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

      // Bootstrap-generated context paths
      const stateDir = join(installed.stateDir);
      const statePath = join(stateDir, "state.json");
      const logsPath = join(stateDir, "logs.txt");

      expect(existsSync(statePath)).toBe(true);
      const stateText = readFileSync(statePath, "utf8");
      expect(stateText).toContain('"carrot": "hello-carrot"');
      expect(stateText).toContain('"bootedAt"');

      expect(existsSync(logsPath)).toBe(true);
      const logsText = readFileSync(logsPath, "utf8");
      expect(logsText).toContain("hello-carrot booted");
      expect(logsText).toContain("channel=carrot:hello-carrot");

      const actionLogs = messages.filter(
        (m): m is ActionMessage =>
          m.type === "action" && m.action === "log",
      );
      expect(actionLogs).toHaveLength(1);
      expect(actionLogs[0].payload?.level).toBe("info");
      expect(actionLogs[0].payload?.message).toContain("hello-carrot ready");

      const readyMessages = messages.filter((m) => m.type === "ready");
      expect(readyMessages).toHaveLength(1);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
