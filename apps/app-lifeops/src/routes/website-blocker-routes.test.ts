import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebsiteBlockerRoutes } from "./website-blocker-routes.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import {
  resetSelfControlStatusCache,
  setSelfControlPluginConfig,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.js";
import type { SelfControlPluginConfig } from "../website-blocker/engine.js";
import type { WebsiteBlockerRouteContext } from "./website-blocker-routes.js";

const tempRoots: string[] = [];

async function createHostsConfig(): Promise<{
  config: SelfControlPluginConfig;
  hostsFilePath: string;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-selfcontrol-routes-"));
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
  resetSelfControlStatusCache();
  setSelfControlPluginConfig(undefined);
  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

async function getHostCheckResponse(host: string) {
  let payload: unknown = null;
  const context: WebsiteBlockerRouteContext = {
    req: { url: `/api/website-blocker?host=${encodeURIComponent(host)}` } as never,
    res: {} as never,
    method: "GET",
    pathname: "/api/website-blocker",
    readJsonBody: vi.fn(),
    json: (_res, data) => {
      payload = data;
    },
    error: vi.fn(),
  };

  const handled = await handleWebsiteBlockerRoutes(context);
  expect(handled).toBe(true);
  return payload as {
    blocked: boolean;
    host: string;
  };
}

describe("website-blocker route host checks", () => {
  it("blocks X consumer hosts but allows X API hosts", async () => {
    const { config } = await createHostsConfig();
    setSelfControlPluginConfig(config);
    await startSelfControlBlock({ websites: ["x.com"], durationMinutes: null }, config);

    expect((await getHostCheckResponse("twitter.com")).blocked).toBe(true);
    expect((await getHostCheckResponse("api.x.com")).blocked).toBe(false);
    expect((await getHostCheckResponse("api.twitter.com")).blocked).toBe(false);

    await stopSelfControlBlock(config);
    resetSelfControlStatusCache();
  });

  it("keeps Google News scoped to news.google.com", async () => {
    const { config } = await createHostsConfig();
    setSelfControlPluginConfig(config);
    await startSelfControlBlock(
      { websites: ["news.google.com"], durationMinutes: null },
      config,
    );

    expect((await getHostCheckResponse("news.google.com")).blocked).toBe(true);
    expect((await getHostCheckResponse("accounts.google.com")).blocked).toBe(
      false,
    );
    expect(
      (await getHostCheckResponse("oauth2.googleapis.com")).blocked,
    ).toBe(false);
    expect(
      (await getHostCheckResponse("openidconnect.googleapis.com")).blocked,
    ).toBe(false);
    expect((await getHostCheckResponse("www.googleapis.com")).blocked).toBe(
      false,
    );

    await stopSelfControlBlock(config);
    resetSelfControlStatusCache();
  });

  it("fails explicitly when blocked-host required task lookup fails", async () => {
    const { config } = await createHostsConfig();
    setSelfControlPluginConfig(config);
    await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: null },
      config,
    );
    const listDefinitions = vi
      .spyOn(LifeOpsRepository.prototype, "listActiveDefinitions")
      .mockRejectedValueOnce(new Error("db offline"));
    const json = vi.fn();
    const error = vi.fn();
    const context: WebsiteBlockerRouteContext = {
      req: {
        url: "/api/website-blocker?host=example.com",
      } as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/website-blocker",
      runtime: {
        agentId: "00000000-0000-0000-0000-000000000000",
      } as never,
      readJsonBody: vi.fn(),
      json,
      error,
    };

    const handled = await handleWebsiteBlockerRoutes(context);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      context.res,
      "Failed to resolve required tasks for blocked host: db offline",
      500,
    );
    expect(json).not.toHaveBeenCalled();
    expect(listDefinitions).toHaveBeenCalledOnce();

    listDefinitions.mockRestore();
    await stopSelfControlBlock(config);
    resetSelfControlStatusCache();
  });
});
