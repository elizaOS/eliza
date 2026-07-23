// Smoke-tests the Electron app example startup path.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Electron backend package", () => {
  test("declares real package scripts without empty test passes", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts.test).toBe("bun test smoke.test.js");
    expect(pkg.scripts.test).not.toContain("--passWithNoTests");
    expect(pkg.scripts.build).toContain("tsc --noCheck");
    expect(pkg.scripts["lint:check"]).toContain("biome check");
    expect(pkg.scripts["format:check"]).toContain("biome format");
  });

  test("keeps the main process wired through a narrow preload IPC bridge", () => {
    const main = read("src/main.ts");
    const preload = read("src/preload.ts");
    const ipc = read("src/ipc.ts");

    expect(main).toContain("registerChatIpc()");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(preload).toContain('exposeInMainWorld("elizaChat"');
    expect(ipc).toContain('ipcMain.handle("chat:getGreeting"');
    expect(ipc).toContain('"chat:sendMessage"');
    expect(ipc).toContain('throw new Error("Missing text")');
  });
});
