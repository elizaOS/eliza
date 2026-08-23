/**
 * Covers handleUpdateRoutes: GET /api/update/status (channel resolution,
 * force=true substring on req.url, trusted-local vs remote display gating,
 * lastCheckAt fallback) and PUT /api/update/channel (null body, schema
 * rejection, persist + cache-bust). Network check/version fetches are
 * isolated; the action plan, channel resolver, VERSION, and local-trust
 * helper run for real.
 */
import type http from "node:http";
import type { ElizaConfig } from "@elizaos/shared";
import { PutUpdateChannelRequestSchema } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../runtime/version.ts";
import { getUpdateActionPlan } from "../services/self-updater.ts";
import { CHANNEL_DIST_TAGS } from "../services/update-checker.ts";
import {
  handleUpdateRoutes,
  type UpdateRouteContext,
} from "./update-routes.ts";

const fakes = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  fetchAllChannelVersions: vi.fn(),
  detectInstallMethod: vi.fn(),
}));

vi.mock("../services/update-checker.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/update-checker.ts")>();
  return {
    ...actual,
    checkForUpdate: fakes.checkForUpdate,
    fetchAllChannelVersions: fakes.fetchAllChannelVersions,
  };
});

vi.mock("../services/self-updater.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/self-updater.ts")>();
  return {
    ...actual,
    detectInstallMethod: fakes.detectInstallMethod,
  };
});

const ENV_KEYS = [
  "ELIZA_UPDATE_CHANNEL",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_CLOUD_API_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearGatingEnv(): void {
  delete process.env.ELIZA_UPDATE_CHANNEL;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.STEWARD_AGENT_TOKEN;
  delete process.env.ELIZA_CLOUD_API_KEY;
}

function makeReq(
  url: string | undefined,
  kind: "untrusted" | "trusted-local" = "untrusted",
): http.IncomingMessage {
  if (kind === "trusted-local") {
    return {
      url,
      headers: { host: "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
  }
  return {
    url,
    headers: {},
    socket: null,
  } as unknown as http.IncomingMessage;
}

function makeCtx(
  method: string,
  pathname: string,
  options: {
    config?: ElizaConfig;
    req?: http.IncomingMessage;
    body?: Record<string, unknown> | null;
  } = {},
): {
  ctx: UpdateRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  saveElizaConfig: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const saveElizaConfig = vi.fn();
  const readJsonBody = vi.fn(async () => options.body ?? null);
  const config: ElizaConfig = options.config ?? {};
  const req = options.req ?? makeReq(pathname);
  const ctx: UpdateRouteContext = {
    req,
    res: {} as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}`),
    state: { config },
    json,
    error,
    readJsonBody: readJsonBody as UpdateRouteContext["readJsonBody"],
    saveElizaConfig,
  };
  return { ctx, json, error, saveElizaConfig, readJsonBody };
}

function stubNetwork(overrides?: {
  updateAvailable?: boolean;
  latestVersion?: string | null;
  error?: string | null;
  versions?: {
    stable: string | null;
    beta: string | null;
    nightly: string | null;
  };
}): void {
  fakes.checkForUpdate.mockResolvedValue({
    updateAvailable: overrides?.updateAvailable ?? true,
    currentVersion: "0.0.1-test",
    latestVersion:
      overrides && "latestVersion" in overrides
        ? overrides.latestVersion
        : "9.9.9",
    channel: "stable",
    distTag: "latest",
    cached: false,
    error: overrides && "error" in overrides ? overrides.error : null,
  });
  fakes.fetchAllChannelVersions.mockResolvedValue(
    overrides?.versions ?? {
      stable: "1.0.0-stable",
      beta: "1.1.0-beta.4",
      nightly: "0.0.0-nightly.88",
    },
  );
}

beforeEach(() => {
  snapshotEnv();
  clearGatingEnv();
  fakes.checkForUpdate.mockReset();
  fakes.fetchAllChannelVersions.mockReset();
  fakes.detectInstallMethod.mockReset();
  fakes.detectInstallMethod.mockReturnValue("npm-global");
  stubNetwork();
});

afterEach(() => {
  restoreEnv();
});

describe("handleUpdateRoutes — unmatched surface", () => {
  it("returns false for an unrelated path and does not fetch", async () => {
    const { ctx, json, error, saveElizaConfig } = makeCtx("GET", "/api/health");

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(fakes.checkForUpdate).not.toHaveBeenCalled();
    expect(fakes.fetchAllChannelVersions).not.toHaveBeenCalled();
  });

  it("does not treat GET /api/update/channel as a match", async () => {
    const { ctx, json } = makeCtx("GET", "/api/update/channel");
    await expect(handleUpdateRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("does not treat PUT /api/update/status as a match", async () => {
    const { ctx, json, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/status",
      { body: { channel: "beta" } },
    );
    await expect(handleUpdateRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("does not treat a trailing-slash status path as a match", async () => {
    const { ctx, json } = makeCtx("GET", "/api/update/status/");
    await expect(handleUpdateRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(fakes.checkForUpdate).not.toHaveBeenCalled();
  });

  it("is method-case-sensitive (lowercase get is not GET)", async () => {
    const { ctx, json } = makeCtx("get", "/api/update/status");
    await expect(handleUpdateRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("handleUpdateRoutes — GET /api/update/status", () => {
  it("assembles status from the real action plan and injected check", async () => {
    fakes.detectInstallMethod.mockReturnValue("npm-global");
    const { ctx, json, error, saveElizaConfig } = makeCtx(
      "GET",
      "/api/update/status",
      {
        config: {
          update: { channel: "beta", lastCheckAt: "2026-01-02T03:04:05.000Z" },
        },
        req: makeReq("/api/update/status"),
      },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    const plan = getUpdateActionPlan("npm-global", "beta", {
      remoteDisplay: true,
    });
    expect(error).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      currentVersion: VERSION,
      channel: "beta",
      installMethod: "npm-global",
      updateAuthority: plan.authority,
      nextAction: plan.nextAction,
      canAutoUpdate: plan.canAutoUpdate,
      canExecuteUpdate: plan.canExecuteFromContext,
      remoteDisplay: true,
      updateCommand: plan.command,
      updateInstructions: plan.message,
      updateAvailable: true,
      latestVersion: "9.9.9",
      channels: {
        stable: "1.0.0-stable",
        beta: "1.1.0-beta.4",
        nightly: "0.0.0-nightly.88",
      },
      distTags: CHANNEL_DIST_TAGS,
      lastCheckAt: "2026-01-02T03:04:05.000Z",
      error: null,
    });
    expect(plan.canExecuteFromContext).toBe(false);
    expect(plan.authority).toBe("package-manager");
  });

  it("defaults the channel to stable and lastCheckAt to null when update config is absent", async () => {
    const { ctx, json } = makeCtx("GET", "/api/update/status");

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        channel: "stable",
        lastCheckAt: null,
      }),
    );
  });

  it("lets ELIZA_UPDATE_CHANNEL override the persisted channel", async () => {
    process.env.ELIZA_UPDATE_CHANNEL = "nightly";
    const { ctx, json } = makeCtx("GET", "/api/update/status", {
      config: { update: { channel: "stable" } },
    });

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    const plan = getUpdateActionPlan("npm-global", "nightly", {
      remoteDisplay: true,
    });
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        channel: "nightly",
        updateCommand: plan.command,
        nextAction: plan.nextAction,
      }),
    );
  });

  it("passes force:true only when req.url contains the force=true substring", async () => {
    const { ctx } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status?x=1&force=true"),
    });

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(fakes.checkForUpdate).toHaveBeenCalledWith({ force: true });
  });

  it("does not treat ctx.url as the force source when req.url omits it", async () => {
    const { ctx } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status"),
    });
    ctx.url = new URL("http://127.0.0.1/api/update/status?force=true");

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(fakes.checkForUpdate).toHaveBeenCalledWith({ force: false });
  });

  it("passes force:false for force=1 / force=TRUE and undefined req.url", async () => {
    const { ctx: one } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status?force=1"),
    });
    await handleUpdateRoutes(one);
    expect(fakes.checkForUpdate).toHaveBeenLastCalledWith({ force: false });

    const { ctx: upper } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status?force=TRUE"),
    });
    await handleUpdateRoutes(upper);
    expect(fakes.checkForUpdate).toHaveBeenLastCalledWith({ force: false });

    const { ctx: missing } = makeCtx("GET", "/api/update/status", {
      req: makeReq(undefined),
    });
    await handleUpdateRoutes(missing);
    expect(fakes.checkForUpdate).toHaveBeenLastCalledWith({
      force: undefined,
    });
  });

  it("treats a substring such as force=trueish as force:true (includes, not parse)", async () => {
    const { ctx } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status?force=trueish"),
    });

    await handleUpdateRoutes(ctx);

    expect(fakes.checkForUpdate).toHaveBeenCalledWith({ force: true });
  });

  it("gates remoteDisplay via the real trusted-local helper", async () => {
    fakes.detectInstallMethod.mockReturnValue("apt");
    const { ctx, json } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status", "trusted-local"),
    });

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    const plan = getUpdateActionPlan("apt", "stable", { remoteDisplay: false });
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        installMethod: "apt",
        remoteDisplay: false,
        canExecuteUpdate: plan.canExecuteFromContext,
        canAutoUpdate: true,
        updateAuthority: "os-package-manager",
        updateInstructions: plan.message,
      }),
    );
    expect(plan.canExecuteFromContext).toBe(true);
  });

  it("keeps canExecuteUpdate false for local-dev even on a trusted-local request", async () => {
    fakes.detectInstallMethod.mockReturnValue("local-dev");
    const { ctx, json } = makeCtx("GET", "/api/update/status", {
      req: makeReq("/api/update/status", "trusted-local"),
    });

    await handleUpdateRoutes(ctx);

    const plan = getUpdateActionPlan("local-dev", "stable", {
      remoteDisplay: false,
    });
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        installMethod: "local-dev",
        nextAction: "run-git-pull",
        updateCommand: "git pull",
        canAutoUpdate: false,
        canExecuteUpdate: false,
        updateInstructions: plan.message,
      }),
    );
  });

  it("forwards the check error string when the registry probe fails", async () => {
    stubNetwork({
      updateAvailable: false,
      latestVersion: null,
      error: "Unable to reach the npm registry. Check your network connection.",
    });
    const { ctx, json } = makeCtx("GET", "/api/update/status");

    await handleUpdateRoutes(ctx);

    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        updateAvailable: false,
        latestVersion: null,
        error:
          "Unable to reach the npm registry. Check your network connection.",
      }),
    );
  });

  it("runs the check and channel-version fetches together", async () => {
    const { ctx } = makeCtx("GET", "/api/update/status");
    await handleUpdateRoutes(ctx);
    expect(fakes.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(fakes.fetchAllChannelVersions).toHaveBeenCalledTimes(1);
  });
});

describe("handleUpdateRoutes — PUT /api/update/channel", () => {
  it("returns true and does not persist when the body reader already failed", async () => {
    const { ctx, json, error, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/channel",
      { body: null },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(ctx.state.config.update).toBeUndefined();
  });

  it("rejects an unknown channel with the schema's first issue and does not persist", async () => {
    const { ctx, json, error, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/channel",
      { body: { channel: "alpha" } },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    const parsed = PutUpdateChannelRequestSchema.safeParse({
      channel: "alpha",
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success
      ? ""
      : (parsed.error.issues[0]?.message ??
        "Invalid channel. Must be stable, beta, or nightly.");
    expect(error).toHaveBeenCalledWith(ctx.res, message);
    expect(json).not.toHaveBeenCalled();
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects a missing channel", async () => {
    const { ctx, error, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/channel",
      { body: {} },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledTimes(1);
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects extra fields (strict schema) without writing config", async () => {
    const { ctx, error, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/channel",
      { body: { channel: "stable", force: true } },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledTimes(1);
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it.each(["stable", "beta", "nightly"] as const)(
    "persists channel=%s, clears the check cache, and echoes the channel",
    async (channel) => {
      const config: ElizaConfig = {
        update: {
          channel: "stable",
          lastCheckAt: "2026-04-01T00:00:00.000Z",
          lastCheckVersion: "1.2.3",
          lastCheckChannel: "stable",
          checkIntervalSeconds: 60,
          checkOnStart: false,
        },
      };
      const { ctx, json, error, saveElizaConfig } = makeCtx(
        "PUT",
        "/api/update/channel",
        { config, body: { channel } },
      );

      await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

      expect(error).not.toHaveBeenCalled();
      expect(ctx.state.config.update).toEqual({
        channel,
        lastCheckAt: undefined,
        lastCheckVersion: undefined,
        lastCheckChannel: "stable",
        checkIntervalSeconds: 60,
        checkOnStart: false,
      });
      expect(saveElizaConfig).toHaveBeenCalledTimes(1);
      expect(saveElizaConfig).toHaveBeenCalledWith(ctx.state.config);
      expect(json).toHaveBeenCalledWith(ctx.res, { channel });
    },
  );

  it("creates the update config object when it was previously missing", async () => {
    const config: ElizaConfig = {};
    const { ctx, json, saveElizaConfig } = makeCtx(
      "PUT",
      "/api/update/channel",
      { config, body: { channel: "beta" } },
    );

    await expect(handleUpdateRoutes(ctx)).resolves.toBe(true);

    expect(config.update).toEqual({
      channel: "beta",
      lastCheckAt: undefined,
      lastCheckVersion: undefined,
    });
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(json).toHaveBeenCalledWith(ctx.res, { channel: "beta" });
  });
});
