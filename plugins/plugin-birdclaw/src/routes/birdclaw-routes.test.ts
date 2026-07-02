import type { IAgentRuntime, RouteHandlerContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { BirdclawExec } from "../birdclaw/cli.ts";
import { BirdclawCliError } from "../birdclaw/cli.ts";
import { BirdclawService } from "../birdclaw/service.ts";
import { birdclawRoutes } from "./birdclaw-routes.ts";

function route(name: string) {
  const found = birdclawRoutes.find((candidate) => candidate.name === name);
  if (!found?.routeHandler) throw new Error(`route ${name} not found`);
  return found.routeHandler;
}

function contextFor(
  service: BirdclawService | null,
  overrides: Partial<RouteHandlerContext> = {},
): RouteHandlerContext {
  const runtime = {
    getSetting: () => undefined,
    getService: (type: string) =>
      type === BirdclawService.serviceType ? service : null,
  } as unknown as IAgentRuntime;
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: "GET",
    path: "/api/birdclaw/status",
    runtime,
    inProcess: true,
    ...overrides,
  } as RouteHandlerContext;
}

function serviceWith(
  respond: (args: readonly string[]) => { stdout: string } | Error,
): BirdclawService {
  const exec: BirdclawExec = async (_bin, args) => {
    const result = respond(args);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: "" };
  };
  const runtime = {
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
  return new BirdclawService(runtime, { exec });
}

const HEALTHY = (args: readonly string[]) => {
  if (args[0] === "--version") return { stdout: "0.8.5" };
  if (args[0] === "db") {
    return {
      stdout: JSON.stringify({
        paths: { rootDir: "/home/user/.birdclaw" },
        stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
        transport: {
          installed: false,
          availableTransport: "local",
          statusText: "xurl not installed. local mode active.",
        },
      }),
    };
  }
  if (args[0] === "search") {
    return {
      stdout: JSON.stringify([
        {
          id: "t1",
          text: "hello",
          createdAt: "2026-03-08T11:18:00.000Z",
          liked: false,
          bookmarked: false,
          author: { handle: "steipete", displayName: "Peter" },
        },
      ]),
    };
  }
  if (args[0] === "inbox") {
    return {
      stdout: JSON.stringify({
        items: [
          {
            id: "m1",
            entityKind: "mention",
            title: "Mention",
            text: "ping",
            createdAt: "2026-03-08T11:48:00.000Z",
            needsReply: true,
          },
        ],
      }),
    };
  }
  if (args[0] === "sync") return { stdout: JSON.stringify({ fetched: 2 }) };
  return new Error(`unexpected argv ${args.join(" ")}`);
};

describe("GET /api/birdclaw/status", () => {
  it("returns installed:false when no service is registered", async () => {
    const result = await route("birdclaw-status")(contextFor(null));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: {
        installed: false,
        message: expect.stringContaining("not available"),
      },
    });
  });

  it("returns the full status when birdclaw is healthy", async () => {
    const result = await route("birdclaw-status")(
      contextFor(serviceWith(HEALTHY)),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: {
        installed: true,
        version: "0.8.5",
        counts: { mentions: 2 },
        transport: { availableTransport: "local" },
      },
    });
  });

  it("returns installed:false with guidance when the binary is missing", async () => {
    const service = serviceWith(
      () => new BirdclawCliError("not-installed", "birdclaw binary not found"),
    );
    const result = await route("birdclaw-status")(contextFor(service));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: {
        installed: false,
        message: expect.stringContaining("brew install steipete/tap/birdclaw"),
      },
    });
  });
});

describe("GET /api/birdclaw/tweets", () => {
  it("rejects an unknown resource", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      query: { resource: "dms" },
    });
    const result = await route("birdclaw-tweets")(ctx);
    expect(result.status).toBe(400);
  });

  it("returns flattened tweets", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      query: { resource: "home", liked: "1", limit: "5" },
    });
    const result = await route("birdclaw-tweets")(ctx);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tweets: [{ id: "t1", authorHandle: "steipete" }],
    });
  });

  it("maps a missing binary to 503 with installed:false", async () => {
    const service = serviceWith(
      () => new BirdclawCliError("not-installed", "birdclaw binary not found"),
    );
    const result = await route("birdclaw-tweets")(contextFor(service));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ installed: false });
  });

  it("maps a CLI failure to 502", async () => {
    const service = serviceWith(
      () => new BirdclawCliError("failed", "database is locked"),
    );
    const result = await route("birdclaw-tweets")(contextFor(service));
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: expect.stringContaining("database is locked"),
    });
  });

  it("returns 503 when no service is registered", async () => {
    const result = await route("birdclaw-tweets")(contextFor(null));
    expect(result.status).toBe(503);
  });
});

describe("GET /api/birdclaw/inbox", () => {
  it("rejects an unknown kind", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), { query: { kind: "spam" } });
    const result = await route("birdclaw-inbox")(ctx);
    expect(result.status).toBe(400);
  });

  it("returns flattened inbox items", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      query: { kind: "mentions" },
    });
    const result = await route("birdclaw-inbox")(ctx);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      items: [{ id: "m1", needsReply: true, kind: "mention" }],
    });
  });
});

describe("POST /api/birdclaw/sync", () => {
  it("rejects an unknown collection", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      method: "POST",
      body: { collection: "everything" },
    });
    const result = await route("birdclaw-sync")(ctx);
    expect(result.status).toBe(400);
  });

  it("runs a valid sync", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      method: "POST",
      body: { collection: "bookmarks" },
    });
    const result = await route("birdclaw-sync")(ctx);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: { collection: "bookmarks", ok: true },
    });
  });

  it("surfaces sync transport failures as 502", async () => {
    const service = serviceWith((args) =>
      args[0] === "sync"
        ? new BirdclawCliError("failed", "xurl not installed")
        : HEALTHY(args),
    );
    const ctx = contextFor(service, {
      method: "POST",
      body: { collection: "timeline" },
    });
    const result = await route("birdclaw-sync")(ctx);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: expect.stringContaining("xurl not installed"),
    });
  });
});

describe("POST /api/birdclaw/digest", () => {
  it("rejects an unknown period", async () => {
    const ctx = contextFor(serviceWith(HEALTHY), {
      method: "POST",
      body: { period: "decade" },
    });
    const result = await route("birdclaw-digest")(ctx);
    expect(result.status).toBe(400);
  });

  it("returns the digest text", async () => {
    const service = serviceWith((args) =>
      args[0] === "digest"
        ? { stdout: JSON.stringify({ digest: "Quiet day." }) }
        : HEALTHY(args),
    );
    const ctx = contextFor(service, {
      method: "POST",
      body: { period: "today" },
    });
    const result = await route("birdclaw-digest")(ctx);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      digest: { period: "today", text: "Quiet day." },
    });
  });
});

describe("route registration", () => {
  it("keeps every route private (no public flag) and rawPath-stable", () => {
    for (const candidate of birdclawRoutes) {
      expect(candidate.public).toBeUndefined();
      expect(candidate.rawPath).toBe(true);
      expect(candidate.path.startsWith("/api/birdclaw/")).toBe(true);
    }
  });
});
