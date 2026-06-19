import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");

function importMap() {
  const match = html.match(
    /<script\s+type="importmap">\s*([\s\S]*?)\s*<\/script>/,
  );
  if (!match) {
    throw new Error("Missing import map");
  }
  return JSON.parse(match[1]);
}

test("static demo defines the browser runtime import map", () => {
  const imports = importMap().imports;

  expect(imports["@elizaos/core"]).toBe(
    "../../../packages/core/dist/browser/index.browser.js",
  );
  expect(imports["@elizaos/plugin-eliza-classic"]).toContain(
    "plugin-eliza-classic/dist/index.browser.js",
  );
  expect(imports["@elizaos/plugin-localdb"]).toContain(
    "plugin-localdb/dist/index.browser.js",
  );
  expect(imports.uuid).toBe("https://esm.sh/uuid@11");
});

test("static demo exposes the required chat controls and runtime wiring", () => {
  for (const id of [
    "chat",
    "init-message",
    "typing",
    "user-input",
    "send-btn",
    "db-status",
    "db-status-text",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }

  expect(html).toContain("new AgentRuntime");
  expect(html).toContain("plugins: [localdbPlugin, elizaClassicPlugin]");
  expect(html).toContain("runtime.messageService.handleMessage");
  expect(html).toContain('source: "browser"');
});
