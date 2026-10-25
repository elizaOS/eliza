/** Real host HTTP and on-disk config acceptance; no mocked route/persistence services. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Memory,
  promoteSubactionsToActions,
  validateToolArgs,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  pluginAction,
  pluginOperationSchemaOverrides,
} from "../src/actions/plugin.ts";
import { runtimeAction } from "../src/actions/runtime.ts";
import { startApiServer } from "../src/api/server.ts";
import { loadElizaConfig } from "../src/config/config.ts";

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
  // Boot copies the saved key into process.env, where providers fall back.
  process.env.OPENAI_API_KEY = secret;
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
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  const secrets = await (await request("/api/secrets")).json();
  expect(
    secrets.secrets.find(
      (entry: { key: string }) => entry.key === "OPENAI_API_KEY",
    ),
  ).toMatchObject({ isSet: false, maskedValue: null });
}, 120_000);

it("replaces a saved connector token so the next boot uses the new value", async () => {
  const previous = `${secret}-connector`;
  const replacement = `${secret}-rotated`;
  for (const container of ["connectors", "channels"]) {
    await server.close();
    await writeFile(
      path.join(directory, "eliza.json"),
      JSON.stringify({ [container]: { discord: { token: previous } } }),
    );
    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
    const response = await request("/api/plugins/discord", "PUT", {
      config: { DISCORD_API_TOKEN: replacement },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = JSON.parse(
      await readFile(path.join(directory, "eliza.json"), "utf8"),
    );
    expect(saved[container].discord.token, container).toBe(replacement);
    // Boot applies config.env first and connector fields last.
    vi.stubEnv("DISCORD_API_TOKEN", undefined);
    vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
    loadElizaConfig();
    expect(process.env.DISCORD_API_TOKEN, container).toBe(replacement);
  }
}, 120_000);

it("keeps the type of a list or true/false connector field it replaces", async () => {
  await server.close();
  await writeFile(
    path.join(directory, "eliza.json"),
    JSON.stringify({
      connectors: {
        discord: { allowFrom: ["1"] },
        imessage: { enabled: true },
      },
    }),
  );
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  for (const [plugin, config] of [
    ["discord", { DISCORD_ALLOW_FROM: "1, 2" }],
    ["imessage", { IMESSAGE_ENABLED: "false" }],
  ] as const) {
    const response = await request(`/api/plugins/${plugin}`, "PUT", {
      config,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const saved = JSON.parse(
    await readFile(path.join(directory, "eliza.json"), "utf8"),
  );
  expect(saved.connectors.discord.allowFrom).toEqual(["1", "2"]);
  expect(saved.connectors.imessage.enabled).toBe(false);
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

it("executes narrow promoted plugin schemas through authenticated HTTP without changing alias or secret boundaries", async () => {
  const fixture = await createTestRuntime({
    characterName: "PluginOperationSchemas",
  });
  vi.stubEnv("ELIZA_PORT", String(server.port));
  const actions = promoteSubactionsToActions(pluginAction, {
    overrides: pluginOperationSchemaOverrides(),
  });
  const operation = (name: string) => {
    const action = actions.find((action) => action.name === name);
    if (!action) throw new Error(`Missing ${name}`);
    expect(action.roleGate).toEqual({ minRole: "OWNER" });
    return action;
  };
  const message: Memory = {
    id: randomUUID(),
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId: randomUUID(),
    content: { text: "Configure the test plugin" },
    createdAt: Date.now(),
  };
  try {
    const runtimeControls = promoteSubactionsToActions(runtimeAction);
    const describe = runtimeControls.find(
      (action) => action.name === "RUNTIME_DESCRIBE_ACTIONS",
    );
    if (!describe) throw new Error("Missing runtime describe action");
    fixture.runtime.registerAction(runtimeAction);
    const described = await describe.handler(
      fixture.runtime,
      message,
      undefined,
      {},
    );
    expect(described).toMatchObject({
      success: true,
      values: { count: fixture.runtime.actions.length },
    });
    expect(described?.text).toContain(runtimeAction.description);
    const retiredInputs: Record<string, string>[] = [
      { action: "list_actions" },
      { action: "restart_agent" },
      { op: "status" },
      { subaction: "status" },
    ];
    for (const parameters of retiredInputs) {
      expect(
        await runtimeAction.handler(fixture.runtime, message, undefined, {
          parameters,
        }),
      ).toMatchObject({ success: false, values: { error: "RUNTIME_INVALID" } });
    }
    const list = operation("PLUGIN_LIST");
    const listFields = list.parameters?.map((parameter) => parameter.name);
    expect(listFields).toEqual(
      expect.arrayContaining(["type", "status", "configured", "search"]),
    );
    expect(listFields).not.toContain("config");
    expect(listFields).not.toContain("stream");
    const listed = await list.handler(fixture.runtime, message, undefined, {
      parameters: { type: "plugin", search: "openai" },
    });
    expect(listed).toMatchObject({ success: true });
    expect(JSON.stringify(listed)).not.toContain(secret);

    const configure = operation("PLUGIN_CONFIGURE");
    expect(
      configure.parameters?.find((parameter) => parameter.name === "config")
        ?.required,
    ).toBe(true);
    expect(
      configure.parameters?.some((parameter) => parameter.name === "enabled"),
    ).toBe(false);
    const configureParameters = {
      connectorId: "openai",
      config: { OPENAI_API_KEY: secret },
    };
    // The planner path validates arguments before the handler runs, so the
    // config map the handler requires must pass the declared schema.
    for (const action of [configure, pluginAction]) {
      expect(
        validateToolArgs(action, {
          ...(action === pluginAction ? { action: "configure" } : {}),
          ...configureParameters,
        }),
      ).toMatchObject({ valid: true, errors: [] });
    }
    const configured = await configure.handler(
      fixture.runtime,
      message,
      undefined,
      { parameters: configureParameters },
    );
    expect(configured).toMatchObject({ success: true });
    expect(JSON.stringify(configured)).not.toContain(secret);
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
        .plugins.entries.openai.config.OPENAI_API_KEY,
    ).toBe(secret);

    const toggle = operation("PLUGIN_TOGGLE");
    expect(
      toggle.parameters?.find((parameter) => parameter.name === "enabled")
        ?.required,
    ).toBe(true);
    expect(
      toggle.parameters?.some((parameter) => parameter.name === "config"),
    ).toBe(false);
    expect(
      await toggle.handler(fixture.runtime, message, undefined, {
        parameters: { pluginId: "openai", enabled: false },
      }),
    ).toMatchObject({ success: true });
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
        .plugins.entries.openai.enabled,
    ).toBe(false);

    const read = await operation("PLUGIN_READ_CONFIG").handler(
      fixture.runtime,
      message,
      undefined,
      { parameters: { pluginId: "openai" } },
    );
    expect(read).toMatchObject({ success: true });
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(
      await list.handler(fixture.runtime, message, undefined, {
        parameters: {
          op: "configure",
          pluginId: "openai",
          config: { OPENAI_API_KEY: "must-not-save" },
        },
      }),
    ).toMatchObject({ success: false });
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
        .plugins.entries.openai.config.OPENAI_API_KEY,
    ).toBe(secret);

    // The bot connector is stopped by disabling it, not by the
    // personal-account cancel route.
    expect(
      await operation("PLUGIN_DISCONNECT").handler(
        fixture.runtime,
        message,
        undefined,
        { parameters: { connectorId: "telegram" } },
      ),
    ).toMatchObject({
      success: true,
      data: { connectorId: "telegram", fallback: "plugin-disable" },
    });
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8"))
        .plugins.entries.telegram.enabled,
    ).toBe(false);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

it("keeps a plugin save made while a settings save is still sending its body", async () => {
  const configPath = path.join(directory, "eliza.json");
  const pluginKey = "sk-synthetic-overlapping-plugin-save-not-real";
  // A settings save whose body is still arriving when the plugin save runs.
  const body = JSON.stringify({ ui: { theme: "dark" } });
  const settings = new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/api/config",
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-forwarded-for": "203.0.113.10",
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(body.slice(0, 5));
    setTimeout(async () => {
      const plugin = await request("/api/plugins/openai", "PUT", {
        config: { OPENAI_API_KEY: pluginKey },
      });
      expect(plugin.status, await plugin.clone().text()).toBe(200);
      req.end(body.slice(5));
    }, 200);
  });
  expect(await settings).toBe(200);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.ui?.theme).toBe("dark");
  expect(saved.plugins.entries.openai.config.OPENAI_API_KEY).toBe(pluginKey);
  // The next save starts from the live config and must keep both changes.
  const later = await request("/api/config", "PUT", { ui: { language: "en" } });
  expect(later.status, await later.clone().text()).toBe(200);
  const after = JSON.parse(await readFile(configPath, "utf8"));
  expect(after.ui?.theme).toBe("dark");
  expect(after.plugins.entries.openai.config.OPENAI_API_KEY).toBe(pluginKey);
}, 60_000);
