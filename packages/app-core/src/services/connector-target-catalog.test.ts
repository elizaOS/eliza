import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ConnectorConfigLike,
  createElizaConnectorTargetCatalog,
} from "./connector-target-catalog";
import { createDiscordSourceCache } from "./discord-target-source";

afterEach(() => {
  vi.clearAllMocks();
});

function makeFetch(
  routes: Record<string, { ok?: boolean; status?: number; body?: unknown }>,
): { fn: typeof fetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (url: string) => {
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          json: async () => response.body ?? [],
        } as unknown as Response;
      }
    }
    throw new Error(`unmocked fetch ${url}`);
  });
  return { fn: mock as unknown as typeof fetch, mock };
}

describe("ElizaConnectorTargetCatalog — Discord", () => {
  it("returns one TargetGroup per Discord guild with text channels as targets", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { enabled: true, token: "tok" } },
    };
    const { fn } = makeFetch({
      "/users/@me/guilds": {
        body: [
          { id: "g1", name: "Cozy Devs" },
          { id: "g2", name: "Other" },
        ],
      },
      "/guilds/g1/channels": {
        body: [
          { id: "c-general", name: "general", type: 0 },
          { id: "c-voice", name: "voice", type: 2 },
        ],
      },
      "/guilds/g2/channels": {
        body: [{ id: "c-only", name: "only-text", type: 0 }],
      },
    });
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fn,
    });
    const groups = await catalog.listGroups();
    expect(groups).toEqual([
      {
        platform: "discord",
        groupId: "g1",
        groupName: "Cozy Devs",
        targets: [{ id: "c-general", name: "general", kind: "channel" }],
      },
      {
        platform: "discord",
        groupId: "g2",
        groupName: "Other",
        targets: [{ id: "c-only", name: "only-text", kind: "channel" }],
      },
    ]);
  });

  it("narrows to a single guild when groupId is supplied", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { token: "tok" } },
    };
    const { fn } = makeFetch({
      "/users/@me/guilds": {
        body: [
          { id: "g1", name: "Cozy Devs" },
          { id: "g2", name: "Other" },
        ],
      },
      "/guilds/g1/channels": {
        body: [{ id: "c", name: "general", type: 0 }],
      },
      "/guilds/g2/channels": { body: [] },
    });
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fn,
    });
    const groups = await catalog.listGroups({
      platform: "discord",
      groupId: "g1",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].groupId).toBe("g1");
  });

  it("returns [] when no Discord token is configured", async () => {
    const fetchImpl = vi.fn();
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => ({ connectors: {} }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await catalog.listGroups()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns [] when Discord guilds REST returns 401 (silent degrade)", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { token: "bad" } },
    };
    const { fn } = makeFetch({
      "/users/@me/guilds": { ok: false, status: 401 },
    });
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fn,
    });
    expect(await catalog.listGroups()).toEqual([]);
  });

  it("returns guild with empty targets when channel fetch is rate-limited", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { token: "tok" } },
    };
    const { fn } = makeFetch({
      "/users/@me/guilds": { body: [{ id: "g", name: "G" }] },
      "/guilds/g/channels": { ok: false, status: 429 },
    });
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fn,
    });
    const groups = await catalog.listGroups();
    expect(groups).toEqual([
      { platform: "discord", groupId: "g", groupName: "G", targets: [] },
    ]);
  });

  it("filters by platform when a non-discord platform is requested", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { token: "tok" } },
    };
    const fetchImpl = vi.fn();
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await catalog.listGroups({ platform: "slack" })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shares its Discord cache when one is supplied", async () => {
    const config: ConnectorConfigLike = {
      connectors: { discord: { token: "tok" } },
    };
    const { fn, mock } = makeFetch({
      "/users/@me/guilds": { body: [{ id: "g", name: "G" }] },
      "/guilds/g/channels": { body: [] },
    });
    const cache = createDiscordSourceCache();
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => config,
      fetchImpl: fn,
      discordCache: cache,
    });
    await catalog.listGroups();
    const callsAfterFirst = mock.mock.calls.length;
    expect(callsAfterFirst).toBe(2);
    await catalog.listGroups();
    expect(mock.mock.calls.length).toBe(callsAfterFirst);
  });
});
