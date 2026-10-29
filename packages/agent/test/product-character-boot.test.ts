/** Actual normal boot reaches the canonical runtime constructor without a model or live profile. */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { afterEach, expect, test, vi } from "vitest";
import { installProductCharacterHost } from "../../app/src/runtime/install-product-character-host.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import { startEliza } from "../src/runtime/eliza.ts";
import { _resetAgentHostBridge } from "../src/runtime/host-bridge.ts";

const roots: string[] = [];
const originalEnvironment = { ...process.env };
afterEach(async () => {
  _resetAgentHostBridge();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "normal runtime construction preserves identity with localAgentMode=%s",
  async (localAgentMode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-boot-"));
    roots.push(root);
    vi.stubEnv("ELIZA_STATE_DIR", root);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", "1");
    vi.stubEnv("ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP", "1");
    vi.stubEnv("ELIZA_DISABLE_AUTO_BOOTSTRAP", "1");
    const config = {
      agents: {
        list: [{ id: "main", default: true, name: "Retained original" }],
        defaults: { workspace: path.join(root, "workspace") },
      },
    };
    const original = buildCharacterFromConfig(config);
    await fs.writeFile(path.join(root, "eliza.json"), JSON.stringify(config));
    const entry = path.join(root, "host.mjs");
    const body =
      'export const nativeCloudRuntime = {apiBaseUrl:"https://cloud.example.com/api/v1",productCharacter:{name:"Alpha",bio:["Product assistant."]}};';
    await fs.writeFile(entry, body);
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({
        version: 1,
        files: { "host.mjs": createHash("sha256").update(body).digest("hex") },
      }),
    );
    await installProductCharacterHost({
      ELIZA_SMTHRS_RUNTIME_DIR: root,
      ELIZA_NATIVE_GOOGLE_HOST_MODULE: entry,
    });
    const model = vi
      .spyOn(AgentRuntime.prototype, "useModel")
      .mockImplementation(async () => {
        throw Error("No inference in boot fixture");
      });
    const stop = new Error("Stop at real constructor");
    let identity: UUID | undefined;
    let display: string | undefined;
    const construct = () =>
      startEliza({
        headless: true,
        localAgentMode,
        onRuntimeCreated(runtime) {
          identity = runtime.agentId;
          display = runtime.character.name;
          throw stop;
        },
      });
    await expect(construct()).rejects.toBe(stop);
    expect(identity).toBe(original.id ?? stringToUuid("Retained original"));
    expect(display).toBe("Alpha");
    await expect(construct()).rejects.toBe(stop);
    expect(identity).toBe(original.id ?? stringToUuid("Retained original"));
    expect(display).toBe("Alpha");
    _resetAgentHostBridge();
    await installProductCharacterHost({});
    await expect(construct()).rejects.toBe(stop);
    expect(identity).toBe(original.id ?? stringToUuid("Retained original"));
    expect(display).toBe("Retained original");
    expect(
      JSON.parse(await fs.readFile(path.join(root, "eliza.json"), "utf8")),
    ).toEqual(config);
    expect(model).not.toHaveBeenCalled();
  },
);
