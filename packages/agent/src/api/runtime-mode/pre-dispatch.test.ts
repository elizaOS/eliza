/**
 * Unit coverage for the runtime-mode pre-dispatch hooks using the real route
 * guard and remote forwarder against isolated on-disk runtime configuration.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  handleRuntimeModePreDispatch,
  handleRuntimeModeRemoteForward,
} from "./pre-dispatch.ts";
import { __resetRuntimeModeSnapshotCacheForTests } from "./runtime-mode.ts";

interface ResponseHarness {
  res: ServerResponse;
  status: () => number;
  body: () => string;
}

const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalConfigPath = process.env.ELIZA_CONFIG_PATH;
const originalPersistConfigPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
let stateDir: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writeConfig(config: object): void {
  fs.writeFileSync(
    path.join(stateDir, "eliza.json"),
    JSON.stringify(config),
    "utf8",
  );
  __resetRuntimeModeSnapshotCacheForTests();
}

function makeRequest(url: string, method = "GET"): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { host: "controller.local" };
  return req;
}

function makeResponse(): ResponseHarness {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => res,
    end: (chunk?: Uint8Array | string) => {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      return res;
    },
  } as unknown as ServerResponse;

  return {
    res,
    status: () => res.statusCode,
    body: () => Buffer.concat(chunks).toString("utf8"),
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-dispatch-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
});

afterEach(() => {
  restoreEnv("ELIZA_STATE_DIR", originalStateDir);
  restoreEnv("ELIZA_CONFIG_PATH", originalConfigPath);
  restoreEnv("ELIZA_PERSIST_CONFIG_PATH", originalPersistConfigPath);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("handleRuntimeModePreDispatch", () => {
  test("passes a local-only route through in local mode", async () => {
    writeConfig({ deploymentTarget: { runtime: "local" } });
    const response = makeResponse();

    const handled = await handleRuntimeModePreDispatch(
      makeRequest("/api/local-inference/hub"),
      response.res,
    );

    expect(handled).toBe(false);
    expect(response.status()).toBe(200);
    expect(response.body()).toBe("");
  });

  test("hides a local-only route with a plain 404 in cloud mode", async () => {
    writeConfig({ deploymentTarget: { runtime: "cloud" } });
    const response = makeResponse();

    const handled = await handleRuntimeModePreDispatch(
      makeRequest("/api/local-inference/hub"),
      response.res,
    );

    expect(handled).toBe(true);
    expect(response.status()).toBe(404);
    expect(JSON.parse(response.body())).toEqual({ error: "Not found" });
  });

  test("passes runtime-declared route visibility to the real guard", async () => {
    writeConfig({
      deploymentTarget: { runtime: "local" },
      cloud: { enabled: false },
    });
    const response = makeResponse();

    const handled = await handleRuntimeModePreDispatch(
      makeRequest("/api/example/preview", "POST"),
      response.res,
      {
        routes: [
          {
            type: "POST",
            path: "/api/example/preview",
            modes: ["local-only"],
            modeReason: "local fixture",
          },
        ],
      },
    );

    expect(handled).toBe(false);
    expect(response.body()).toBe("");
  });
});

describe("handleRuntimeModeRemoteForward", () => {
  test("passes a forwardable mutation through outside remote mode", async () => {
    writeConfig({ deploymentTarget: { runtime: "local" } });
    const response = makeResponse();

    const handled = await handleRuntimeModeRemoteForward(
      makeRequest("/api/cloud/login", "POST"),
      response.res,
    );

    expect(handled).toBe(false);
    expect(response.body()).toBe("");
  });

  test("handles a remote mutation when its target is not configured", async () => {
    writeConfig({ deploymentTarget: { runtime: "remote" } });
    const response = makeResponse();

    const handled = await handleRuntimeModeRemoteForward(
      makeRequest("/api/cloud/login", "POST"),
      response.res,
    );

    expect(handled).toBe(true);
    expect(response.status()).toBe(400);
    expect(JSON.parse(response.body())).toEqual({
      error: "Remote target not configured",
    });
  });
});
