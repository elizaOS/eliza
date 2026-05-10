import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SandboxRow {
  id: string;
  status: string;
  bridge_url: string | null;
  web_ui_port: number | null;
}

const state: { rows: Map<string, SandboxRow> } = { rows: new Map() };

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findById: async (id: string): Promise<SandboxRow | undefined> => state.rows.get(id),
  },
}));

const { resolveAgentRouting, readRouterConfig } = await import(
  "../../scripts/daemons/agent-router"
);

describe("resolveAgentRouting", () => {
  beforeEach(() => {
    state.rows.clear();
  });

  test("returns null when sandbox is missing", async () => {
    expect(await resolveAgentRouting("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("returns null when sandbox status is not running", async () => {
    state.rows.set("11111111-1111-1111-1111-111111111111", {
      id: "11111111-1111-1111-1111-111111111111",
      status: "pending",
      bridge_url: "http://1.2.3.4:19000",
      web_ui_port: 21000,
    });
    expect(await resolveAgentRouting("11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  test("returns null when bridge_url or web_ui_port is missing", async () => {
    state.rows.set("22222222-2222-2222-2222-222222222222", {
      id: "22222222-2222-2222-2222-222222222222",
      status: "running",
      bridge_url: null,
      web_ui_port: 21000,
    });
    state.rows.set("33333333-3333-3333-3333-333333333333", {
      id: "33333333-3333-3333-3333-333333333333",
      status: "running",
      bridge_url: "http://1.2.3.4:19000",
      web_ui_port: null,
    });

    expect(await resolveAgentRouting("22222222-2222-2222-2222-222222222222")).toBeNull();
    expect(await resolveAgentRouting("33333333-3333-3333-3333-333333333333")).toBeNull();
  });

  test("returns null when bridge_url is not a valid URL", async () => {
    state.rows.set("44444444-4444-4444-4444-444444444444", {
      id: "44444444-4444-4444-4444-444444444444",
      status: "running",
      bridge_url: "not a url",
      web_ui_port: 21000,
    });
    expect(await resolveAgentRouting("44444444-4444-4444-4444-444444444444")).toBeNull();
  });

  test("returns the routing payload for a healthy sandbox", async () => {
    state.rows.set("55555555-5555-5555-5555-555555555555", {
      id: "55555555-5555-5555-5555-555555555555",
      status: "running",
      bridge_url: "http://195.201.57.227:19610",
      web_ui_port: 23790,
    });
    expect(await resolveAgentRouting("55555555-5555-5555-5555-555555555555")).toEqual({
      headscaleIp: "195.201.57.227",
      bridgePort: 19610,
      webUiPort: 23790,
      target: "195.201.57.227:23790",
    });
  });

  test("returns null when bridge_url has no explicit port", async () => {
    // Sandboxes always store bridge_url with an explicit port. A portless URL
    // is treated as malformed rather than silently defaulting to 80.
    state.rows.set("66666666-6666-6666-6666-666666666666", {
      id: "66666666-6666-6666-6666-666666666666",
      status: "running",
      bridge_url: "http://1.2.3.4",
      web_ui_port: 21000,
    });
    expect(await resolveAgentRouting("66666666-6666-6666-6666-666666666666")).toBeNull();
  });

  test("returns null when status is the empty string", async () => {
    state.rows.set("77777777-7777-7777-7777-777777777777", {
      id: "77777777-7777-7777-7777-777777777777",
      status: "",
      bridge_url: "http://1.2.3.4:19000",
      web_ui_port: 21000,
    });
    expect(await resolveAgentRouting("77777777-7777-7777-7777-777777777777")).toBeNull();
  });

  test("returns null when web_ui_port is 0 (falsy)", async () => {
    // web_ui_port === 0 is rejected by the daemon's `!sandbox.web_ui_port`
    // check. Documenting this so a future switch to `== null` is intentional.
    state.rows.set("88888888-8888-8888-8888-888888888888", {
      id: "88888888-8888-8888-8888-888888888888",
      status: "running",
      bridge_url: "http://1.2.3.4:19000",
      web_ui_port: 0,
    });
    expect(await resolveAgentRouting("88888888-8888-8888-8888-888888888888")).toBeNull();
  });
});

describe("readRouterConfig", () => {
  test("uses defaults when env is empty", () => {
    expect(readRouterConfig({} as NodeJS.ProcessEnv)).toEqual({
      port: 3458,
      bindHost: "127.0.0.1",
    });
  });

  test("reads AGENT_ROUTER_PORT and AGENT_ROUTER_BIND_HOST from env", () => {
    expect(
      readRouterConfig({
        AGENT_ROUTER_PORT: "4567",
        AGENT_ROUTER_BIND_HOST: "0.0.0.0",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      port: 4567,
      bindHost: "0.0.0.0",
    });
  });

  test("falls back to defaults on invalid values", () => {
    expect(
      readRouterConfig({
        AGENT_ROUTER_PORT: "not-a-number",
        AGENT_ROUTER_BIND_HOST: "   ",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      port: 3458,
      bindHost: "127.0.0.1",
    });
  });

  test("falls back to default port when AGENT_ROUTER_PORT is zero or negative", () => {
    expect(readRouterConfig({ AGENT_ROUTER_PORT: "0" } as NodeJS.ProcessEnv)).toEqual({
      port: 3458,
      bindHost: "127.0.0.1",
    });
    expect(readRouterConfig({ AGENT_ROUTER_PORT: "-1" } as NodeJS.ProcessEnv)).toEqual({
      port: 3458,
      bindHost: "127.0.0.1",
    });
  });

  test("uses custom port with default bind host when only port is set", () => {
    expect(readRouterConfig({ AGENT_ROUTER_PORT: "4567" } as NodeJS.ProcessEnv)).toEqual({
      port: 4567,
      bindHost: "127.0.0.1",
    });
  });

  test("uses custom bind host with default port when only host is set", () => {
    expect(
      readRouterConfig({
        AGENT_ROUTER_BIND_HOST: "0.0.0.0",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      port: 3458,
      bindHost: "0.0.0.0",
    });
  });

  test("trims whitespace from AGENT_ROUTER_BIND_HOST", () => {
    expect(
      readRouterConfig({
        AGENT_ROUTER_BIND_HOST: "  10.0.0.1  ",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      port: 3458,
      bindHost: "10.0.0.1",
    });
  });
});
