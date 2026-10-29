/** Real admitted-module loading and downward host injection; no live profile or provider. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _resetAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { afterEach, expect, test } from "vitest";
import { installProductCharacterHost } from "./install-product-character-host.js";
import { parseNativeCloudRuntimeDeclaration } from "./native-runtime-profile.js";

const roots: string[] = [];
afterEach(() => {
  _resetAgentHostBridge();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(
  character: unknown = { name: "Alpha", bio: ["Product assistant."] },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-host-"));
  roots.push(root);
  const entry = path.join(root, "host.mjs");
  const body = `export const nativeCloudRuntime = ${JSON.stringify({ apiBaseUrl: "https://cloud.example.com/api/v1", productCharacter: character })};`;
  fs.writeFileSync(entry, body);
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      files: { "host.mjs": createHash("sha256").update(body).digest("hex") },
    }),
  );
  return {
    root,
    entry,
    env: {
      ELIZA_SMTHRS_RUNTIME_DIR: root,
      ELIZA_NATIVE_GOOGLE_HOST_MODULE: entry,
    },
  };
}

test.each(["dev-cloud", "android-signed-out", "android-signed-in"])(
  "loads product identity without provider authority: %s",
  async (mode) => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = {
      ...f.env,
      ELIZA_PLATFORM: mode.startsWith("android") ? "android" : "darwin",
      ...(mode === "android-signed-in"
        ? {
            ELIZAOS_CLOUD_API_KEY: "synthetic-only",
            ELIZA_NATIVE_GOOGLE_BINDING_JSON: "{}",
          }
        : {}),
    };
    const before = { ...env };
    await installProductCharacterHost(env);
    expect(getAgentHostBridge().productCharacter).toEqual({
      name: "Alpha",
      bio: ["Product assistant."],
    });
    expect(env).toEqual(before);
    expect(env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
    expect(Object.isFrozen(getAgentHostBridge().productCharacter)).toBe(true);
    await installProductCharacterHost(env);
    expect(getAgentHostBridge().productCharacter?.name).toBe("Alpha");
  },
);

test("missing module retains the upstream default", async () => {
  await installProductCharacterHost({});
  expect(getAgentHostBridge().productCharacter).toBeUndefined();
});

test("rejects tampering and escaped resources before host installation", async () => {
  const f = fixture();
  fs.appendFileSync(f.entry, "\nthrow Error('must not execute');");
  await expect(installProductCharacterHost(f.env)).rejects.toMatchObject({
    code: "NATIVE_RUNTIME_MODULE_UNAVAILABLE",
  });
  await expect(
    installProductCharacterHost({
      ...f.env,
      ELIZA_NATIVE_GOOGLE_HOST_MODULE: path.join(f.root, "..", "foreign.mjs"),
    }),
  ).rejects.toMatchObject({ code: "NATIVE_RUNTIME_MODULE_UNAVAILABLE" });
  expect(getAgentHostBridge().productCharacter).toBeUndefined();
});

test("rejects identity IDs, settings and invalid bios in admitted product data", async () => {
  for (const character of [
    { name: "" },
    { name: "Alpha", id: "other" },
    { name: "Alpha", settings: { identityName: "other" } },
    { name: "Alpha", bio: [12] },
  ]) {
    const f = fixture(character);
    await expect(installProductCharacterHost(f.env)).rejects.toThrow(
      /declaration is invalid/,
    );
    expect(getAgentHostBridge().productCharacter).toBeUndefined();
  }
});

test("legacy declarations remain compatible", () => {
  expect(
    parseNativeCloudRuntimeDeclaration({
      apiBaseUrl: "https://cloud.example.com/api/v1",
    }),
  ).toEqual({ apiBaseUrl: "https://cloud.example.com/api/v1" });
});

test("normal Cloud and native entry chains install product before runtime startup", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dev = fs.readFileSync(path.join(here, "dev-server.ts"), "utf8");
  expect(dev).toContain("await installProductCharacterHost();");
  expect(dev.indexOf("await installProductCharacterHost();")).toBeLessThan(
    dev.indexOf('scheduleRuntimeBootstrap(0, "startup")'),
  );
  const native = fs.readFileSync(
    path.join(here, "../mobile-agent-entry.ts"),
    "utf8",
  );
  expect(native).toContain("await installProductCharacterHost();");
  expect(native.indexOf("await installProductCharacterHost();")).toBeLessThan(
    native.indexOf('await import("@elizaos/agent/bin")'),
  );
  const agent = fs.readFileSync(
    path.join(here, "../../../agent/src/runtime/eliza.ts"),
    "utf8",
  );
  expect(agent).toContain(
    "buildProductCharacterFromConfig(config, productCharacter)",
  );
  expect(agent.indexOf("applyCanonicalFileBootToConfig(config);")).toBeLessThan(
    agent.indexOf("buildProductCharacterFromConfig(config, productCharacter)"),
  );
  expect(
    agent.indexOf("buildProductCharacterFromConfig(config, productCharacter)"),
  ).toBeGreaterThan(agent.indexOf("let character = restoredGeneration"));
  expect(agent.indexOf("const agentId = scopeName?")).toBeLessThan(
    agent.indexOf("buildProductCharacterFromConfig(config, productCharacter)"),
  );
});
