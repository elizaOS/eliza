import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Electron example workspace", () => {
  test("delegates parent scripts to renderer and main-process packages", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts["dev:renderer"]).toContain("--cwd frontend");
    expect(pkg.scripts["dev:electron"]).toContain("--cwd backend");
    expect(pkg.scripts["build:renderer"]).toContain("--cwd frontend");
    expect(pkg.scripts.start).toContain("--cwd backend");
  });

  test("exposes a narrow preload API backed by IPC handlers", () => {
    const preload = read("backend/src/preload.ts");
    const ipc = read("backend/src/ipc.ts");

    expect(preload).toContain('exposeInMainWorld("elizaChat"');
    expect(preload).toContain('ipcRenderer.invoke("chat:sendMessage"');
    expect(ipc).toContain('ipcMain.handle("chat:getGreeting"');
    expect(ipc).toContain('ipcMain.handle("chat:getHistory"');
    expect(ipc).toContain('ipcMain.handle("chat:reset"');
    expect(ipc).toContain('"chat:sendMessage"');
    expect(ipc).toContain('throw new Error("Missing text")');
  });
});
