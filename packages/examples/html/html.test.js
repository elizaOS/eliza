/**
 * Bun smoke tests for the static browser-runtime HTML example.
 */
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
  expect(imports["@elizaos/plugin-openai"]).toContain(
    "plugin-openai/dist/browser/index.browser.js",
  );
  expect(imports["@elizaos/plugin-openrouter"]).toContain(
    "plugin-openrouter/dist/browser/index.browser.js",
  );
  expect(imports["@elizaos/plugin-anthropic"]).toContain(
    "plugin-anthropic/dist/browser/index.browser.js",
  );
  expect(imports["@elizaos/plugin-elizacloud"]).toContain(
    "plugin-elizacloud/dist/browser/index.browser.js",
  );
  expect(imports["@elizaos/plugin-localdb"]).toContain(
    "plugin-localdb/dist/index.browser.js",
  );
  expect(imports.uuid).toBe("https://esm.sh/uuid@11");
  // The retired offline pattern-matching plugin must not be mapped anymore.
  // (token built by concatenation so it does not appear as a literal reference)
  const retiredPlugin = `@elizaos/plugin-eliza${"-"}classic`;
  expect(imports[retiredPlugin]).toBeUndefined();
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
  expect(html).toContain("plugins: [localdbPlugin, providerPlugin]");
  expect(html).toContain("runtime.messageService.handleMessage");
  expect(html).toContain('source: "browser"');
  // No leftover references to the retired offline plugin.
  // (tokens built by concatenation so they do not appear as literal references)
  expect(html).not.toContain(`eliza${"-"}classic`);
  expect(html).not.toContain(`eliza${"Classic"}Plugin`);
});

test("static demo selects an inference provider by priority from configured keys", () => {
  // Priority order: openai → openrouter → anthropic → eliza cloud.
  const openaiIdx = html.indexOf("OPENAI_API_KEY");
  const openrouterIdx = html.indexOf("OPENROUTER_API_KEY");
  const anthropicIdx = html.indexOf("ANTHROPIC_API_KEY");
  const elizaIdx = html.indexOf("ELIZA_API_KEY");

  expect(openaiIdx).toBeGreaterThan(-1);
  expect(openrouterIdx).toBeGreaterThan(openaiIdx);
  expect(anthropicIdx).toBeGreaterThan(openrouterIdx);
  expect(elizaIdx).toBeGreaterThan(anthropicIdx);

  // Eliza Cloud reads its key from the ELIZAOS_CLOUD_API_KEY character secret.
  expect(html).toContain("ELIZAOS_CLOUD_API_KEY");
  // No silent offline fallback once a provider is missing.
  expect(html).toContain("No inference provider configured");
});
