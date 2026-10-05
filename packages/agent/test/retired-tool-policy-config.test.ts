import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { buildConfigSchema } from "../src/config/schema.ts";
import { ToolPolicySchema } from "../src/config/zod-schema.agent-runtime.ts";
import { ElizaSchema } from "../src/config/zod-schema.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function configFile() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "retired-tool-policy-"),
  );
  directories.push(directory);
  const file = path.join(directory, "config.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", file);
  vi.stubEnv("ELIZA_CONFIG_PERSIST_PATH", file);
  return file;
}

it.each([
  { tools: { profile: "minimal" } },
  { tools: { allow: ["read"] } },
  { tools: { deny: ["terminal"] } },
  { tools: { alsoAllow: ["read"] } },
  { tools: { byProvider: { openai: { profile: "coding" } } } },
  { agents: { list: [{ id: "review", tools: { deny: ["terminal"] } }] } },
  { tools: { sandbox: { tools: { deny: ["terminal"] } } } },
  { tools: { subagents: { tools: { allow: ["read"] } } } },
])("rejects tool restrictions the runtime cannot enforce: %j", (config) => {
  const result = ElizaSchema.safeParse(config);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(
      result.error.issues.some((issue) =>
        issue.message.includes("not enforced"),
      ),
    ).toBe(true);
  }
});

it("rejects shared connector policy restrictions", () => {
  expect(ToolPolicySchema.safeParse({ deny: ["terminal"] }).success).toBe(
    false,
  );
});

it("keeps unrestricted policies and supported tool settings valid", () => {
  expect(
    ElizaSchema.safeParse({
      tools: {
        profile: "full",
        allow: [],
        deny: [],
        alsoAllow: [],
        web: { search: { maxResults: 5 } },
      },
    }).success,
  ).toBe(true);
  expect(ToolPolicySchema.safeParse({}).success).toBe(true);
});

it("refuses actual disk load before config environment hydration", () => {
  const file = configFile();
  vi.stubEnv("RETIRED_POLICY_HYDRATION_CANARY", "before");
  fs.writeFileSync(
    file,
    JSON.stringify({
      tools: { profile: "minimal" },
      env: { vars: { RETIRED_POLICY_HYDRATION_CANARY: "after" } },
    }),
  );
  expect(() => loadElizaConfig()).toThrow("not enforced");
  expect(process.env.RETIRED_POLICY_HYDRATION_CANARY).toBe("before");
});

it("refuses actual save without changing the previous file", () => {
  const file = configFile();
  const previous = '{"tools":{"profile":"full"}}';
  fs.writeFileSync(file, previous);
  expect(() => saveElizaConfig({ tools: { deny: ["terminal"] } })).toThrow(
    "not enforced",
  );
  expect(fs.readFileSync(file, "utf8")).toBe(previous);
});

it("refuses nested connector sender restrictions on actual load", () => {
  const file = configFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      connectors: {
        discord: {
          guilds: {
            review: {
              channels: {
                review: { toolsBySender: { reviewer: { deny: ["terminal"] } } },
              },
            },
          },
        },
      },
    }),
  );
  expect(() => loadElizaConfig()).toThrow("not enforced");
});

it("hides retired global and per-agent policy controls", () => {
  const hints = buildConfigSchema().uiHints;
  for (const prefix of [
    "tools",
    "agents.list[].tools",
    "agents.list.*.tools",
  ]) {
    for (const key of ["profile", "allow", "alsoAllow", "deny", "byProvider"]) {
      expect(hints[`${prefix}.${key}`]?.hidden).toBe(true);
    }
  }
});

it("refuses an explicit runtime override before starting the agent", async () => {
  const { startEliza } = await import("../src/runtime/eliza.ts");
  await expect(
    startEliza({
      headless: true,
      configOverride: { tools: { profile: "minimal" } },
    }),
  ).rejects.toMatchObject({ code: "CONFIG_TOOL_POLICY_UNSUPPORTED" });
});

it.each([{ toolProfile: "minimal" }, { tools: { deny: ["terminal"] } }])(
  "refuses retired character settings on actual disk load: %j",
  (settings) => {
    const file = configFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ agents: { list: [{ id: "review", settings }] } }),
    );
    expect(() => loadElizaConfig()).toThrow("not enforced");
  },
);

it("refuses retired character settings before building the runtime character", async () => {
  const { buildCharacterFromConfig } = await import(
    "../src/runtime/build-character-config.ts"
  );
  expect(() =>
    buildCharacterFromConfig({
      agents: {
        list: [{ id: "review", settings: { tools: { deny: ["terminal"] } } }],
      },
    }),
  ).toThrow("not enforced");
});

it("refuses an injected retired policy without changing the configured character", async () => {
  const { applySandboxCharacterFromEnv } = await import(
    "../src/runtime/sandbox-character.ts"
  );
  const config = { agents: { list: [{ id: "original", name: "Original" }] } };
  const before = structuredClone(config);
  expect(() =>
    applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({
        name: "Override",
        settings: { toolProfile: "minimal" },
      }),
    }),
  ).toThrow("not enforced");
  expect(config).toEqual(before);
});

it("keeps unrestricted character settings and unrelated plugin settings", async () => {
  const { buildCharacterFromConfig } = await import(
    "../src/runtime/build-character-config.ts"
  );
  const settings = {
    toolProfile: "full",
    tools: { deny: [], allow: [] },
    CUSTOM_PLUGIN_SETTING: "enabled",
  };
  const character = buildCharacterFromConfig({
    agents: { list: [{ id: "review", settings }] },
  });
  expect(character.settings).toMatchObject(settings);
});

it("refuses retired character settings on save without changing previous bytes", () => {
  const file = configFile();
  const previous = '{"agents":{"list":[{"id":"review"}]}}';
  fs.writeFileSync(file, previous);
  expect(() =>
    saveElizaConfig({
      agents: { list: [{ id: "review", settings: { toolProfile: "coding" } }] },
    }),
  ).toThrow("not enforced");
  expect(fs.readFileSync(file, "utf8")).toBe(previous);
});
