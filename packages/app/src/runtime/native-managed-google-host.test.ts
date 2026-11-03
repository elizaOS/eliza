import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  redactLogValue,
  redactSensitiveLogText,
} from "../../../core/src/security/log-redaction.ts";
import {
  startNativeManagedGoogleHost,
  startNativeManagedGoogleHostForBoot,
} from "./native-managed-google-host.js";
import type { NativeRuntimeProfileStores } from "./native-runtime-profile.js";

const API_BASE = "https://cloud.example.com/api/v1";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
/** In-memory config and routing stores: tests never touch a real profile. */
function memoryStores(fail?: Error) {
  const state: {
    config?: Record<string, unknown>;
    routing?: unknown;
    calls: number;
  } = { calls: 0 };
  const stores: NativeRuntimeProfileStores = {
    loadConfig: () => {
      state.calls += 1;
      if (fail) throw fail;
      return { cloud: { apiKey: "desktop-key" }, serviceRouting: {} };
    },
    saveConfig: (config) => {
      state.config = structuredClone(config);
    },
    updateRoutingPreferences: async (update) => {
      state.routing = update({ preferredProvider: {}, policy: {} });
    },
  };
  return { stores, state };
}
function fixture(
  declaration = `{ apiBaseUrl: ${JSON.stringify(API_BASE)} }`,
  expectedToken?: string,
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-google-admission-")),
  );
  roots.push(root);
  const entry = path.join(root, "google-host.mjs");
  const bytes = Buffer.from(`export const nativeCloudRuntime = ${declaration};
  export async function startNativeGoogleAgentHost(options) {
    options.assertCurrent();
    ${expectedToken ? `if (options.binding.token !== ${JSON.stringify(expectedToken)}) throw Error("Wrong service credential");` : ""}
    return {port:47899,async close(){}};
  }`);
  fs.writeFileSync(entry, bytes);
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      files: {
        "google-host.mjs": createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ELIZA_PLATFORM: "android",
    ELIZA_SMTHRS_RUNTIME_DIR: root,
    ELIZA_NATIVE_GOOGLE_HOST_MODULE: entry,
    ELIZA_NATIVE_GOOGLE_BINDING_JSON: "{}",
    ELIZAOS_CLOUD_API_KEY: "synthetic-only",
    ELIZAOS_CLOUD_BASE_URL: API_BASE,
    ELIZAOS_CLOUD_SMALL_MODEL: "cerebras/qwen-3.8-27b",
    ELIZAOS_CLOUD_LARGE_MODEL: "cerebras/qwen-3.8-27b",
    ELIZA_API_TOKEN: "Z_-q".repeat(16),
  };
  return { root, entry, env, ...memoryStores() };
}
test("authenticated native resource loading publishes read ports, withholds Gmail send by default and retires them together", async () => {
  const f = fixture();
  const host = await startNativeManagedGoogleHost(f.env);
  expect(host).toBeDefined();
  for (const name of [
    "ELIZA_MANAGED_GMAIL_READ_BROKER",
    "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
    "ELIZA_MANAGED_CALENDAR_READ_BROKER",
  ])
    expect(f.env[name]).toBe("http://127.0.0.1:47899/__alpha-owner-gmail");
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBeUndefined();
  await host?.close();
  expect(f.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
  expect(f.env.ELIZA_MANAGED_GMAIL_OPERATION_BROKER).toBeUndefined();
  expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBeUndefined();
});
test("Gmail send is published only when the host explicitly enables it", async () => {
  const f = fixture();
  f.env.ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED = "1";
  const host = await startNativeManagedGoogleHost(f.env);
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBe(
    "http://127.0.0.1:47899/__alpha-owner-gmail",
  );
  await host?.close();
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBeUndefined();
});
test("native host refuses altered modules, foreign resource paths and desktop activation", async () => {
  const altered = fixture();
  fs.appendFileSync(altered.entry, "\nthrow Error('must not run');");
  await expect(startNativeManagedGoogleHost(altered.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
  const escaped = fixture();
  escaped.env.ELIZA_NATIVE_GOOGLE_HOST_MODULE = path.join(
    escaped.root,
    "..",
    "foreign.mjs",
  );
  await expect(startNativeManagedGoogleHost(escaped.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
  const desktop = fixture();
  desktop.env.ELIZA_PLATFORM = "darwin";
  await expect(startNativeManagedGoogleHost(desktop.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
});
test("boot admission failures leave Google unavailable without stopping the agent or leaking the binding", async () => {
  const f = fixture();
  delete f.env.ELIZAOS_CLOUD_API_KEY;
  const warnings: string[] = [];
  await expect(
    startNativeManagedGoogleHostForBoot(f.env, (m) => warnings.push(m)),
  ).resolves.toBeUndefined();
  expect(warnings.join("\n")).toContain(
    "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE",
  );
  const malformed = fixture();
  malformed.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON = '{"grant":"private-grant"';
  const error = await startNativeManagedGoogleHost(malformed.env).catch(
    (e: unknown) => e as Error,
  );
  expect(error).toMatchObject({
    code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE",
  });
  expect(String((error as Error).message)).not.toContain("private-grant");
  const badToken = fixture();
  badToken.env.ELIZA_API_TOKEN = "short";
  await expect(
    startNativeManagedGoogleHost(badToken.env),
  ).rejects.toMatchObject({ code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" });
  expect(badToken.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
});

test.each([
  API_BASE,
  "https://127.0.0.1:8877/api/v1",
  "https://10.0.2.2:8877/api/v1",
])(
  "orgless Cloud admission prepares routing for %s without publishing Google brokers",
  async (apiBaseUrl) => {
    const f = fixture(`{ apiBaseUrl: ${JSON.stringify(apiBaseUrl)} }`);
    f.env.ELIZAOS_CLOUD_BASE_URL = apiBaseUrl;
    f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
    delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
    expect(
      await startNativeManagedGoogleHostForBoot(f.env, undefined, f.stores),
    ).toBeUndefined();
    expect(f.state.config).toMatchObject({
      cloud: { enabled: true, baseUrl: apiBaseUrl },
      serviceRouting: {
        embeddings: { backend: "eliza-local-inference", transport: "direct" },
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });
    expect(f.state.config?.cloud).not.toHaveProperty("apiKey");
    expect(f.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
    expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBeUndefined();
  },
);

test("Cloud routing failures stop boot instead of falling back to another provider", async () => {
  for (const variant of [
    { declaration: "undefined" },
    { declaration: '{ apiBaseUrl: "http://cloud.example.com/api/v1" }' },
    { declaration: `{ apiBaseUrl: ${JSON.stringify(API_BASE)}, extra: true }` },
    { baseUrl: "https://other.example.com/api/v1" },
    { profile: "hosted" },
    { storeFailure: new Error("private-provider-detail") },
  ]) {
    const f = fixture(variant.declaration);
    const failing = memoryStores(variant.storeFailure);
    f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
    if (variant.baseUrl) f.env.ELIZAOS_CLOUD_BASE_URL = variant.baseUrl;
    if (variant.profile) f.env.ELIZA_RUNTIME_PROFILE = variant.profile;
    delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
    const warnings: string[] = [];
    const error = await startNativeManagedGoogleHostForBoot(
      f.env,
      (m) => warnings.push(m),
      failing.stores,
    ).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: "NATIVE_CLOUD_ROUTING_UNAVAILABLE" });
    expect(String((error as Error | undefined)?.message)).not.toContain(
      "private-provider-detail",
    );
    expect(failing.state.config).toBeUndefined();
    expect(warnings).toEqual([]);
  }
});

test.each([
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_API_TOKEN",
  "ELIZA_NATIVE_GOOGLE_HOST_MODULE",
])("Cloud admission requires %s before preparation", async (key) => {
  const f = fixture();
  f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
  delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
  delete f.env[key];
  await expect(
    startNativeManagedGoogleHostForBoot(f.env, undefined, f.stores),
  ).rejects.toMatchObject({ code: "NATIVE_CLOUD_ROUTING_UNAVAILABLE" });
  expect(f.state.calls).toBe(0);
});

test("disabled Cloud without Google binding leaves routing untouched", async () => {
  const f = fixture();
  f.env.ELIZAOS_CLOUD_USE_INFERENCE = "false";
  delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
  expect(
    await startNativeManagedGoogleHostForBoot(f.env, undefined, f.stores),
  ).toBeUndefined();
  expect(f.state.calls).toBe(0);
});

test("Cloud preparation preserves optional Google failure isolation", async () => {
  const f = fixture();
  f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
  f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON = "{malformed";
  const warnings: string[] = [];
  expect(
    await startNativeManagedGoogleHostForBoot(
      f.env,
      (m) => warnings.push(m),
      f.stores,
    ),
  ).toBeUndefined();
  expect(f.state.config).toBeDefined();
  expect(warnings).toHaveLength(1);
  expect(f.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
});

test("bound Google still starts after Cloud preparation", async () => {
  const f = fixture();
  f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
  const host = await startNativeManagedGoogleHostForBoot(
    f.env,
    undefined,
    f.stores,
  );
  expect(f.state.config).toBeDefined();
  expect(f.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBe(
    "http://127.0.0.1:47899/__alpha-owner-gmail",
  );
  await host?.close();
});

function directFixture() {
  const f = fixture(undefined, "synthetic-google-service-key");
  const previous = {
    cloud: { enabled: true, inferenceMode: "cloud", apiKey: "desktop-key" },
    serviceRouting: {
      llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
    },
  };
  f.stores.loadConfig = () => {
    f.state.calls++;
    return structuredClone(f.state.config ?? previous);
  };
  Object.assign(f.env, {
    ELIZA_RUNTIME_PROFILE: "native",
    ELIZA_PROVIDER: "cerebras",
    CEREBRAS_API_KEY: "synthetic-inference-key",
    CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
    CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
    CEREBRAS_LARGE_MODEL: "qwen-3.8-27b",
    ELIZAOS_CLOUD_USE_INFERENCE: "false",
    ELIZA_NATIVE_GOOGLE_API_KEY: "synthetic-google-service-key",
  });
  delete f.env.ELIZAOS_CLOUD_API_KEY;
  return f;
}
test("own inference prepares direct routing and retains independently admitted Google services", async () => {
  const f = directFixture();
  const host = await startNativeManagedGoogleHostForBoot(
    f.env,
    undefined,
    f.stores,
  );
  expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBe(
    "http://127.0.0.1:47899/__alpha-owner-gmail",
  );
  expect(f.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  expect(f.state.config).toMatchObject({
    cloud: { enabled: false, inferenceMode: "local" },
    serviceRouting: {
      llmText: { backend: "cerebras", transport: "direct" },
      embeddings: { backend: "eliza-local-inference" },
    },
  });
  expect(JSON.stringify(f.state.config)).not.toContain("synthetic-");
  expect(f.state.routing).toMatchObject({
    preferredProvider: { TEXT_SMALL: "openai", TEXT_LARGE: "openai" },
  });
  await host?.close();
  expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBeUndefined();
  delete f.env.ELIZA_PROVIDER;
  delete f.env.CEREBRAS_API_KEY;
  delete f.env.ELIZA_NATIVE_GOOGLE_API_KEY;
  f.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
  f.env.ELIZAOS_CLOUD_API_KEY = "synthetic-google-service-key";
  const cloud = await startNativeManagedGoogleHostForBoot(
    f.env,
    undefined,
    f.stores,
  );
  expect(f.state.config).toMatchObject({
    cloud: { enabled: true, inferenceMode: "cloud" },
    serviceRouting: {
      llmText: { backend: "elizacloud", transport: "cloud-proxy" },
    },
  });
  await cloud?.close();
});
test("own inference still prepares and boots after the Cloud account signs out", async () => {
  const f = directFixture();
  delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
  delete f.env.ELIZA_NATIVE_GOOGLE_API_KEY;
  expect(
    await startNativeManagedGoogleHostForBoot(f.env, undefined, f.stores),
  ).toBeUndefined();
  expect(f.state.config).toMatchObject({
    cloud: { enabled: false },
    serviceRouting: { llmText: { backend: "cerebras" } },
  });
  expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBeUndefined();
});
test("direct routing store failure cannot boot with a stale Cloud route", async () => {
  const f = directFixture(),
    failing = memoryStores(new Error("private-provider-detail"));
  await expect(
    startNativeManagedGoogleHostForBoot(f.env, undefined, failing.stores),
  ).rejects.toMatchObject({ code: "NATIVE_DIRECT_ROUTING_UNAVAILABLE" });
  expect(failing.state.config).toBeUndefined();
});

test("the private Google service key is redacted by shared structured and text logging", () => {
  const key = "ELIZA_NATIVE_GOOGLE_API_KEY",
    secret = "synthetic-google-service-key";
  expect(
    JSON.stringify(redactLogValue({ [key]: secret }, new WeakSet(), 0)),
  ).not.toContain(secret);
  expect(redactSensitiveLogText(`${key}=${secret}`)).not.toContain(secret);
});

test("the admitted synthetic native recovery endpoint survives direct routing projection", async () => {
  const f = directFixture();
  f.env.CEREBRAS_BASE_URL = "http://127.0.0.1:47869/v1";
  f.env.CEREBRAS_API_KEY = "synthetic-resident-recovery-only";
  delete f.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON;
  delete f.env.ELIZA_NATIVE_GOOGLE_API_KEY;
  expect(
    await startNativeManagedGoogleHostForBoot(f.env, undefined, f.stores),
  ).toBeUndefined();
  expect(f.env.CEREBRAS_BASE_URL).toBe("http://127.0.0.1:47869/v1");
  expect(f.state.config).toMatchObject({
    serviceRouting: { llmText: { backend: "cerebras", transport: "direct" } },
  });
});
