import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Electrobun packaging contract", () => {
  it("emits the Bun entrypoint at the launcher-owned index.js path", () => {
    const configSource = readFileSync(
      resolve(process.cwd(), "electrobun.config.ts"),
      "utf8",
    );

    expect(configSource).toContain('entrypoint: "src/main/electrobun-main.ts"');
    expect(configSource).toContain('naming: "index.[ext]"');
  });

  it("uses relocatable renderer assets in the packaged app", () => {
    const viteConfigSource = readFileSync(
      resolve(process.cwd(), "vite.config.ts"),
      "utf8",
    );

    expect(viteConfigSource).toContain('base: "./"');
  });

  it("serves the packaged renderer over loopback instead of file URLs", () => {
    const mainSource = readFileSync(
      resolve(process.cwd(), "src/main/electrobun-main.ts"),
      "utf8",
    );

    expect(mainSource).toContain("async function startRendererServer(");
    expect(mainSource).toContain('hostname: "127.0.0.1"');
    expect(mainSource).not.toContain("pathToFileURL");
  });

  it("injects the backend URL as the renderer's shared API base", () => {
    const mainSource = readFileSync(
      resolve(process.cwd(), "src/main/electrobun-main.ts"),
      "utf8",
    );

    expect(mainSource).toContain("buildPreloadScript(backendUrl, authToken)");
    expect(mainSource).not.toContain("buildPreloadScript(rendererUrl)");
  });
});
