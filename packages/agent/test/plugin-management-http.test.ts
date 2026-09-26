/** Real host HTTP and on-disk config acceptance; no mocked route/persistence services. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

let directory: string;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID();
const secret = "sk-synthetic-plugin-management-secret-not-real";

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-plugin-management-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  await writeFile(path.join(directory, "eliza.json"), "{}");
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(
  route: string,
  method = "GET",
  body?: object,
  authenticated = true,
) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

it("rejects unauthorized and undeclared mutations, persists credentials across host restart, and redacts reads", async () => {
  expect((await request("/api/secrets", "GET", undefined, false)).status).toBe(
    401,
  );
  expect(
    (
      await request(
        "/api/plugins/openai",
        "PUT",
        { config: { OPENAI_API_KEY: secret } },
        false,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/api/plugins/openai", "PUT", {
        config: { NODE_OPTIONS: "--inspect" },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await request("/api/secrets", "PUT", {
        secrets: { NOT_DECLARED_SECRET: secret },
      })
    ).status,
  ).toBe(422);
  expect(
    JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8")),
  ).toEqual({});
  const response = await request("/api/plugins/openai", "PUT", {
    config: { OPENAI_API_KEY: secret },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.text()).not.toContain(secret);
  const saved = JSON.parse(
    await readFile(path.join(directory, "eliza.json"), "utf8"),
  );
  expect(saved.plugins.entries.openai.config.OPENAI_API_KEY).toBe(secret);
  expect(saved.env.OPENAI_API_KEY).toBe(secret);
  await server.close();
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  const inventory = await request("/api/secrets");
  expect(inventory.status).toBe(200);
  const text = await inventory.text();
  expect(text).not.toContain(secret);
  expect(
    JSON.parse(text).secrets.find(
      (entry: { key: string }) => entry.key === "OPENAI_API_KEY",
    ),
  ).toMatchObject({ isSet: true, maskedValue: "********" });
  const replacement = `${secret}-replacement`;
  const update = await request("/api/secrets", "PUT", {
    secrets: { OPENAI_API_KEY: replacement },
  });
  expect(update.status).toBe(200);
  expect(await update.json()).toMatchObject({
    ok: true,
    updated: ["OPENAI_API_KEY"],
  });
  expect(
    JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
      .plugins.entries.openai.config.OPENAI_API_KEY,
  ).toBe(replacement);
  for (const enabled of [false, true]) {
    const toggled = await request("/api/plugins/openai", "PUT", { enabled });
    expect(toggled.status, await toggled.clone().text()).toBe(200);
    const config = JSON.parse(
      await readFile(path.join(directory, "eliza.json"), "utf8"),
    );
    expect(config.plugins.entries.openai.enabled).toBe(enabled);
    expect(config.plugins.entries.openai.config.OPENAI_API_KEY).toBe(
      replacement,
    );
    expect(config.plugins.allow.includes("@elizaos/plugin-openai")).toBe(
      enabled,
    );
  }
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", directory);
  try {
    const failedSave = await request("/api/secrets", "PUT", {
      secrets: { OPENAI_API_KEY: `${secret}-must-not-publish` },
    });
    expect(failedSave.status).toBe(500);
    expect(await failedSave.text()).not.toContain(secret);
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
        .plugins.entries.openai.config.OPENAI_API_KEY,
    ).toBe(replacement);
  } finally {
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(directory, "eliza.json"));
  }
  expect((await request("/api/plugins/not-loaded/test", "POST")).status).toBe(
    404,
  );
  expect((await request("/api/plugins/%ZZ/test", "POST")).status).toBe(400);
  expect(
    (
      await request("/api/plugins/core/toggle", "POST", {
        npmName: "not-an-optional-plugin",
        enabled: false,
      })
    ).status,
  ).toBe(400);
}, 120_000);

it("executes registered connection probes and keeps provider errors private", async () => {
  await server.close();
  const plugins = [
    {
      name: "management-probe",
      description: "Synthetic real HTTP probe",
      health: async () => ({ ok: true }),
    },
    {
      name: "management-failed-probe",
      description: "Synthetic failing probe",
      health: async () => {
        throw new Error(secret);
      },
    },
    { name: "management-no-probe", description: "No connection test" },
  ] satisfies Array<
    import("@elizaos/core").Plugin & {
      health?: () => Promise<{ ok: boolean }>;
    }
  >;
  const fixture = await createTestRuntime({
    characterName: "PluginManagementHttp",
    plugins,
  });
  try {
    server = await startApiServer({
      port: 0,
      runtime: fixture.runtime,
      skipDeferredStartupWork: true,
    });
    const healthy = await request("/api/plugins/management-probe/test", "POST");
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({
      success: true,
      message: "Connection successful",
    });
    const failed = await request(
      "/api/plugins/management-failed-probe/test",
      "POST",
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(secret);
    expect(
      (await request("/api/plugins/management-no-probe/test", "POST")).status,
    ).toBe(501);
  } finally {
    await server.close();
    await fixture.cleanup();
    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  }
}, 120_000);

it("normalizes npm-name configuration on enable and clears every persisted credential source", async () => {
  await server.close();
  await writeFile(
    path.join(directory, "eliza.json"),
    JSON.stringify({
      env: { vars: { OPENAI_API_KEY: secret } },
      plugins: {
        entries: {
          "@elizaos/plugin-openai": {
            enabled: false,
            config: { OPENAI_API_KEY: secret },
          },
        },
      },
    }),
  );
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  const enabled = await request("/api/plugins/openai", "PUT", {
    enabled: true,
  });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const enabledConfig = JSON.parse(
    await readFile(path.join(directory, "eliza.json"), "utf8"),
  );
  expect(
    enabledConfig.plugins.entries["@elizaos/plugin-openai"],
  ).toBeUndefined();
  expect(enabledConfig.plugins.entries.openai).toMatchObject({
    enabled: true,
    config: { OPENAI_API_KEY: secret },
  });
  const cleared = await request("/api/secrets", "PUT", {
    secrets: { OPENAI_API_KEY: "" },
  });
  expect(cleared.status, await cleared.clone().text()).toBe(200);
  expect(await cleared.json()).toMatchObject({
    ok: true,
    updated: ["OPENAI_API_KEY"],
    applications: [{ pluginId: "openai", mode: "none" }],
  });
  const config = JSON.parse(
    await readFile(path.join(directory, "eliza.json"), "utf8"),
  );
  expect(config.env.vars.OPENAI_API_KEY).toBeUndefined();
  expect(config.plugins.entries.openai.config.OPENAI_API_KEY).toBe("");
  const secrets = await (await request("/api/secrets")).json();
  expect(
    secrets.secrets.find(
      (entry: { key: string }) => entry.key === "OPENAI_API_KEY",
    ),
  ).toMatchObject({ isSet: false, maskedValue: null });
}, 120_000);

it("applies saved secrets to a live plugin's cached configuration", async () => {
  await server.close();
  await writeFile(
    path.join(directory, "eliza.json"),
    JSON.stringify({
      plugins: {
        allow: ["@elizaos/plugin-openai"],
        entries: {
          openai: { enabled: true, config: { OPENAI_API_KEY: secret } },
        },
      },
    }),
  );
  let cachedCredential = secret;
  const fixture = await createTestRuntime({
    characterName: "PluginCredentialApplyHttp",
    plugins: [
      {
        name: "openai",
        description:
          "Synthetic plugin with a real lifecycle configuration hook",
        applyConfig: async (config) => {
          const credential = config.OPENAI_API_KEY;
          if (typeof credential !== "string")
            throw new Error("Credential was not passed to applyConfig");
          cachedCredential = credential;
        },
      },
    ],
  });
  try {
    server = await startApiServer({
      port: 0,
      runtime: fixture.runtime,
      skipDeferredStartupWork: true,
    });
    const replacement = `${secret}-live`;
    const response = await request("/api/secrets", "PUT", {
      secrets: { OPENAI_API_KEY: replacement },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      applications: [{ pluginId: "openai", mode: "config_apply" }],
      requiresRestart: false,
    });
    expect(cachedCredential).toBe(replacement);
    expect(fixture.runtime.getSetting("OPENAI_API_KEY")).toBe(replacement);
  } finally {
    await server.close();
    await fixture.cleanup();
    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  }
}, 120_000);
