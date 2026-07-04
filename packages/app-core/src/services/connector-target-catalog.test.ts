/**
 * Covers createElizaConnectorTargetCatalog: aggregating registered connector
 * target sources into groups, re-reading the source registry on every call,
 * platform filtering without invoking non-matching sources, forwarding the
 * getConfig/fetch/clock/logger seams into enumerate, and concatenating groups
 * across multiple sources. Sources are in-test fakes / vi.fn stubs.
 */
import type { TargetSource } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createElizaConnectorTargetCatalog,
  type TargetGroup,
} from "./connector-target-catalog";

const DISCORD_GROUPS: TargetGroup[] = [
  {
    platform: "discord",
    groupId: "g1",
    groupName: "Cozy Devs",
    targets: [{ id: "c1", name: "general", kind: "channel" }],
  },
];

function discordSource(
  enumerate: TargetSource["enumerate"] = async () => DISCORD_GROUPS,
): TargetSource {
  return { platform: "discord", enumerate };
}

describe("createElizaConnectorTargetCatalog", () => {
  it("emits a registered source's groups — Discord present (done-when)", async () => {
    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => [discordSource()],
      getConfig: () => ({ connectors: { discord: { token: "t" } } }),
    });
    expect(await catalog.listGroups()).toEqual(DISCORD_GROUPS);
  });

  it("emits nothing when no source is registered — empty without plugin (done-when)", async () => {
    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => [],
      getConfig: () => ({}),
    });
    expect(await catalog.listGroups()).toEqual([]);
    expect(await catalog.listGroups({ platform: "discord" })).toEqual([]);
  });

  it("re-reads the registry on every call (source registered after boot)", async () => {
    let sources: TargetSource[] = [];
    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => sources,
      getConfig: () => ({}),
    });
    expect(await catalog.listGroups()).toEqual([]);
    sources = [discordSource()];
    expect(await catalog.listGroups()).toEqual(DISCORD_GROUPS);
  });

  it("filters by platform without invoking non-matching sources", async () => {
    const discordEnum = vi.fn(async () => DISCORD_GROUPS);
    const slackEnum = vi.fn(async () => [] as TargetGroup[]);
    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => [
        { platform: "discord", enumerate: discordEnum },
        { platform: "slack", enumerate: slackEnum },
      ],
      getConfig: () => ({}),
    });

    expect(await catalog.listGroups({ platform: "discord" })).toEqual(
      DISCORD_GROUPS,
    );
    expect(discordEnum).toHaveBeenCalledOnce();
    expect(slackEnum).not.toHaveBeenCalled();
  });

  it("forwards groupId + getConfig + fetch/clock seams into enumerate", async () => {
    const enumerate = vi.fn<TargetSource["enumerate"]>(
      async () => DISCORD_GROUPS,
    );
    const getConfig = () => ({ connectors: { discord: { token: "tok" } } });
    const fetchImpl = (async () => new Response()) as unknown as typeof fetch;
    const now = () => 123;
    const logger = { warn: vi.fn() };

    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => [{ platform: "discord", enumerate }],
      getConfig,
      fetchImpl,
      now,
      logger,
    });
    await catalog.listGroups({ platform: "discord", groupId: "g1" });

    const ctx = enumerate.mock.calls.at(0)?.[0];
    if (!ctx) throw new Error("expected enumerate to receive a context");
    expect(ctx.groupId).toBe("g1");
    expect(ctx.getConfig).toBe(getConfig);
    expect(ctx.fetchImpl).toBe(fetchImpl);
    expect(ctx.now).toBe(now);
    expect(ctx.logger).toBe(logger);
  });

  it("concatenates groups across multiple registered sources", async () => {
    const slackGroups: TargetGroup[] = [
      {
        platform: "slack",
        groupId: "w1",
        groupName: "Acme",
        targets: [{ id: "s1", name: "random", kind: "channel" }],
      },
    ];
    const catalog = createElizaConnectorTargetCatalog({
      listSources: () => [
        discordSource(),
        { platform: "slack", enumerate: async () => slackGroups },
      ],
      getConfig: () => ({}),
    });
    expect(await catalog.listGroups()).toEqual([
      ...DISCORD_GROUPS,
      ...slackGroups,
    ]);
  });
});
