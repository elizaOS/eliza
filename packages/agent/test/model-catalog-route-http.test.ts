/** Real HTTP proof for configured provider model-catalog refreshes. */
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  getOrFetchAllProviders,
  getOrFetchProvider,
  providerCachePath,
} from "../src/api/model-provider-helpers.ts";
import { handleModelsRoutes } from "../src/api/models-routes.ts";
import { resolveModelsCacheDir } from "../src/config/paths.ts";

let stateDirectory: string;
let upstream: Server | undefined;
let api: Server | undefined;
let upstreamStatus = 200;
let upstreamModels = [
  { id: "fixture-chat", name: "Fixture Chat", type: "chat" },
];
let upstreamRequests: string[] = [];
let malformedBody: unknown;
let apiOrigin: string;

beforeAll(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-model-catalog-"));
  upstream = createServer((req, res) => {
    upstreamRequests.push(req.url ?? "");
    res.statusCode = upstreamStatus;
    res.setHeader("content-type", "application/json");
    res.end(
      upstreamStatus === 200
        ? JSON.stringify(
            malformedBody === undefined
              ? { data: upstreamModels }
              : malformedBody,
          )
        : JSON.stringify({ error: "invalid_api_key" }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") {
    throw new Error("Missing upstream test address");
  }
  vi.stubEnv("ELIZA_STATE_DIR", stateDirectory);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-model-catalog-key");
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${upstreamAddress.port}/v1`);

  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      const handled = await handleModelsRoutes({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        json(target, payload, status = 200) {
          target.statusCode = status;
          target.setHeader("content-type", "application/json");
          target.end(JSON.stringify(payload));
        },
        providerCachePath,
        getOrFetchProvider,
        getOrFetchAllProviders,
        resolveModelsCacheDir,
        pathExists: fs.existsSync,
        readDir: fs.readdirSync,
        unlinkFile: fs.unlinkSync,
        joinPath: path.join,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === "string") {
    throw new Error("Missing API test address");
  }
  apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
});

afterAll(async () => {
  const servers = [api, upstream].filter(
    (server): server is Server => server !== undefined,
  );
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  vi.unstubAllEnvs();
  await rm(stateDirectory, { recursive: true, force: true });
});

it("refreshes OpenAI-compatible models from the configured endpoint", async () => {
  upstreamStatus = 200;
  upstreamModels = [{ id: "fixture-chat", name: "Fixture Chat", type: "chat" }];
  upstreamRequests = [];

  const response = await fetch(
    `${apiOrigin}/api/models?provider=openai&refresh=true`,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    provider: "openai",
    models: [{ id: "fixture-chat", name: "Fixture Chat", category: "chat" }],
  });
  expect(upstreamRequests).toEqual(["/v1/models"]);
});

it("returns a typed gateway failure when the provider rejects refresh", async () => {
  upstreamStatus = 401;
  upstreamRequests = [];

  const response = await fetch(
    `${apiOrigin}/api/models?provider=openai&refresh=true`,
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "Failed to fetch models from openai (upstream returned 401)",
    code: "MODEL_CATALOG_FETCH_FAILED",
    provider: "openai",
  });
  expect(upstreamRequests).toEqual(["/v1/models"]);
});

it("keeps a successful empty provider catalog distinct from a failure", async () => {
  upstreamStatus = 200;
  upstreamModels = [];
  upstreamRequests = [];

  const response = await fetch(
    `${apiOrigin}/api/models?provider=openai&refresh=true`,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    provider: "openai",
    models: [],
  });
  expect(upstreamRequests).toEqual(["/v1/models"]);
});

it.each([
  {},
  { data: null },
  { data: [{ name: "missing id" }] },
  { data: [{ id: 3 }] },
  { data: [{ id: "model", name: 3 }] },
])("rejects malformed successful catalog bodies: %j", async (body) => {
  upstreamStatus = 200;
  malformedBody = body;
  try {
    const response = await fetch(
      `${apiOrigin}/api/models?provider=openai&refresh=true`,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "MODEL_CATALOG_FETCH_FAILED",
      provider: "openai",
    });
  } finally {
    malformedBody = undefined;
  }
});
