import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createElizaPlugin } from "../src/runtime/eliza-plugin.ts";

const savedEnv = {
  ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
};
let stateDir: string;
let runtimeHandle: Awaited<ReturnType<typeof createTestRuntime>>;

function savedAction(id: string, name: string, enabled: boolean) {
  return {
    id,
    name,
    description: `Look up ${name.toLowerCase()} status`,
    similes: [],
    parameters: [],
    handler: { type: "http", method: "GET", url: "https://example.com/" },
    enabled,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-custom-actions-"));
  const configPath = path.join(stateDir, "eliza.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      customActions: [
        savedAction(
          "6b0f7a52-1b8e-4c1e-9d55-2f4a9e0c1a01",
          "CHECK_WEATHER",
          true,
        ),
        savedAction(
          "6b0f7a52-1b8e-4c1e-9d55-2f4a9e0c1a02",
          "CHECK_TRAFFIC",
          false,
        ),
      ],
    }),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  runtimeHandle = await createTestRuntime({
    characterName: "CustomActionsStartup",
  });
}, 180_000);

afterAll(async () => {
  await runtimeHandle?.cleanup();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("registers enabled saved custom actions when the plugin initializes", async () => {
  const { runtime } = runtimeHandle;
  await createElizaPlugin({ workspaceDir: stateDir }).init?.({}, runtime);
  const names = runtime.actions.map((action) => action.name);
  expect(names).toContain("CHECK_WEATHER");
  expect(names).not.toContain("CHECK_TRAFFIC");
});
