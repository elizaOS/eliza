import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSelfControlManagedHostsBlock,
  isWebsiteBlockSinkholeAddress,
  parseResolvedAddressesFromDscacheutilOutput,
  reconcileSelfControlBlockState,
  type SelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "./engine.js";

const tempRoots: string[] = [];

async function createHostsConfig(): Promise<{
  config: SelfControlPluginConfig;
  hostsFilePath: string;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-selfcontrol-"));
  tempRoots.push(tempRoot);
  const hostsFilePath = path.join(tempRoot, "hosts");
  await writeFile(hostsFilePath, "127.0.0.1 localhost\n", "utf8");

  return {
    hostsFilePath,
    config: {
      hostsFilePath,
    },
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

describe("website blocker engine", () => {
  it("parses resolver output and recognizes sinkhole addresses", () => {
    expect(
      parseResolvedAddressesFromDscacheutilOutput(
        [
          "name: x.com",
          "ipv6_address: ::1",
          "",
          "name: x.com",
          "ip_address: 162.159.140.229",
        ].join("\n"),
      ),
    ).toEqual(["::1", "162.159.140.229"]);

    expect(isWebsiteBlockSinkholeAddress("127.0.0.1")).toBe(true);
    expect(isWebsiteBlockSinkholeAddress("127.0.0.42")).toBe(true);
    expect(isWebsiteBlockSinkholeAddress("::1")).toBe(true);
    expect(isWebsiteBlockSinkholeAddress("162.159.140.229")).toBe(false);
  });

  it("expands apex domains to include www", async () => {
    const { config, hostsFilePath } = await createHostsConfig();

    const result = await startSelfControlBlock(
      {
        websites: ["example.com"],
        durationMinutes: null,
      },
      config,
    );

    expect(result).toEqual({
      success: true,
      endsAt: null,
    });

    const hosts = await readFile(hostsFilePath, "utf8");
    expect(hosts).toContain("0.0.0.0 example.com");
    expect(hosts).toContain("0.0.0.0 www.example.com");
  });

  it("removes stale ineffective managed block markers from status", async () => {
    const { config, hostsFilePath } = await createHostsConfig();
    const staleBlock = buildSelfControlManagedHostsBlock({
      version: 1,
      startedAt: "2026-04-19T03:00:00.000Z",
      endsAt: null,
      websites: ["x.com"],
      requestedWebsites: ["x.com"],
      managedBy: "eliza-selfcontrol",
      metadata: null,
      scheduledByAgentId: null,
    });
    await writeFile(
      hostsFilePath,
      `127.0.0.1 localhost\n${staleBlock}`,
      "utf8",
    );

    const status = await reconcileSelfControlBlockState({
      ...config,
      validateSystemResolution: true,
      resolvedAddressLookup: async () => ["162.159.140.229"],
    });

    expect(status.active).toBe(false);
    expect(status.reason).toContain("removed a stale website block");
    expect(await readFile(hostsFilePath, "utf8")).toBe("127.0.0.1 localhost\n");
  });

  it("does not reject a new block because of stale ineffective markers", async () => {
    const { config, hostsFilePath } = await createHostsConfig();
    const staleBlock = buildSelfControlManagedHostsBlock({
      version: 1,
      startedAt: "2026-04-19T03:00:00.000Z",
      endsAt: null,
      websites: ["x.com"],
      requestedWebsites: ["x.com"],
      managedBy: "eliza-selfcontrol",
      metadata: null,
      scheduledByAgentId: null,
    });
    await writeFile(
      hostsFilePath,
      `127.0.0.1 localhost\n${staleBlock}`,
      "utf8",
    );

    const result = await startSelfControlBlock(
      {
        websites: ["reddit.com"],
        durationMinutes: null,
      },
      {
        ...config,
        validateSystemResolution: true,
        resolvedAddressLookup: async (website) =>
          website === "x.com" ? ["162.159.140.229"] : ["127.0.0.1"],
      },
    );

    expect(result).toEqual({
      success: true,
      endsAt: null,
    });

    const hosts = await readFile(hostsFilePath, "utf8");
    expect(hosts).not.toContain("0.0.0.0 x.com");
    expect(hosts).toContain("0.0.0.0 reddit.com");
  });

  it("expands x.com into the hostnames X actually needs while preserving simple status text", async () => {
    const { config, hostsFilePath } = await createHostsConfig();

    const result = await startSelfControlBlock(
      {
        websites: ["x.com"],
        durationMinutes: null,
      },
      config,
    );

    expect(result).toEqual({
      success: true,
      endsAt: null,
    });

    const hosts = await readFile(hostsFilePath, "utf8");
    for (const hostname of [
      "x.com",
      "www.x.com",
      "mobile.x.com",
      "api.x.com",
      "twitter.com",
      "t.co",
      "abs.twimg.com",
      "pbs.twimg.com",
      "video.twimg.com",
    ]) {
      expect(hosts).toContain(`0.0.0.0 ${hostname}`);
    }

    const status = await reconcileSelfControlBlockState(config);
    expect(status.active).toBe(true);
    expect(status.websites).toEqual(["x.com"]);
    expect(status.blockedWebsites).toEqual(
      expect.arrayContaining([
        "x.com",
        "www.x.com",
        "mobile.x.com",
        "api.x.com",
        "twitter.com",
        "t.co",
      ]),
    );

    const stopResult = await stopSelfControlBlock(config);
    expect(stopResult.success).toBe(true);
  });
});
