#!/usr/bin/env bun
// Drives repo automation capability router fixture server with explicit CLI and CI behavior.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import {
  CAPABILITY_ROUTER_PROTOCOL_FIXTURE,
  type JsonObject,
  type JsonValue,
  type RuntimeBrokerCapabilityMethod,
} from "../core/src/capabilities/index.ts";

type Options = {
  host: string;
  port: number;
  token?: string;
  assetPath?: string;
  bundlePath: string;
  readyFile?: string;
};

const options = parseArgs(process.argv.slice(2));
const moduleManifest = buildModuleManifest(options.bundlePath);
const assetBody = readAssetBody(options.assetPath);

const server = createServer(async (request, response) => {
  try {
    if (!isAuthorized(request, options.token)) {
      return json(response, 401, {
        ok: false,
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "Capability router request is not authorized.",
        },
      });
    }
    const url = new URL(request.url ?? "/", `http://${options.host}`);
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      return json(
        response,
        200,
        CAPABILITY_ROUTER_PROTOCOL_FIXTURE.availability,
      );
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/v1/capabilities/assets/")
    ) {
      return serveAsset(url, response);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/capabilities/invoke"
    ) {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.method !== "string") {
        return json(response, 400, {
          ok: false,
          error: {
            code: "CAPABILITY_DECODE_FAILED",
            message: "Capability invoke body must include method.",
          },
        });
      }
      const params = isRecord(body.params) ? body.params : {};
      return json(response, 200, {
        ok: true,
        result: invokeFixture(
          body.method as RuntimeBrokerCapabilityMethod,
          params,
        ),
      });
    }
    return json(response, 404, {
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE", message: "Not found." },
    });
  } catch (error) {
    return json(response, 500, {
      ok: false,
      error: {
        code: "CAPABILITY_REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve fixture server address.");
  }
  const baseUrl = `http://${options.host}:${address.port}`;
  const ready = {
    baseUrl,
    token: options.token ?? null,
    moduleId: moduleManifest.id,
    bundlePath: options.bundlePath,
  };
  if (options.readyFile) {
    mkdirSync(dirname(options.readyFile), { recursive: true });
    writeFileSync(options.readyFile, `${JSON.stringify(ready)}\n`);
  }
  console.log(JSON.stringify(ready));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

function invokeFixture(
  method: RuntimeBrokerCapabilityMethod,
  params: JsonObject,
): JsonValue {
  switch (method) {
    case "plugin.modules.list":
      return { modules: [moduleManifest] };
    case "plugin.action.invoke":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action;
    case "plugin.provider.get":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider;
    case "plugin.route.call":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route;
    case "plugin.asset.get":
      requireModule(params);
      requireAssetPath(params);
      return assetResult();
    case "plugin.model.invoke":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model;
    case "plugin.lifecycle.call":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle;
    case "plugin.event.handle":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event;
    case "plugin.service.call":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service;
    case "plugin.appBridge.call":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge;
    case "plugin.evaluator.shouldRun":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun;
    case "plugin.evaluator.prepare":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare;
    case "plugin.evaluator.prompt":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt;
    case "plugin.evaluator.process":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess;
    case "plugin.responseHandlerEvaluator.shouldRun":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerEvaluatorShouldRun;
    case "plugin.responseHandlerEvaluator.evaluate":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerEvaluatorEvaluate;
    case "plugin.responseHandlerFieldEvaluator.shouldRun":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorShouldRun;
    case "plugin.responseHandlerFieldEvaluator.parse":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorParse;
    case "plugin.responseHandlerFieldEvaluator.handle":
      requireModule(params);
      return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorHandle;
    default:
      throw new Error(`Fixture server does not implement ${method}.`);
  }
}

function serveAsset(url: URL, response: ServerResponse): void {
  const prefix = "/v1/capabilities/assets/";
  const remainder = url.pathname.slice(prefix.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    json(response, 400, {
      ok: false,
      error: {
        code: "CAPABILITY_DECODE_FAILED",
        message: "Capability asset URL must include module id and path.",
      },
    });
    return;
  }
  const moduleId = decodeURIComponent(remainder.slice(0, slashIndex));
  const assetPath = `/${remainder.slice(slashIndex + 1)}`;
  if (moduleId !== moduleManifest.id || assetPath !== options.bundlePath) {
    json(response, 404, {
      ok: false,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        message: "Fixture asset not found.",
      },
    });
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "text/javascript; charset=utf-8");
  response.end(assetBody);
}

function buildModuleManifest(bundlePath: string) {
  return {
    ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
    views: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.views.map((view) => ({
      ...view,
      bundlePath,
      contentType: "text/javascript",
    })),
  };
}

function readAssetBody(assetPath: string | undefined): Buffer {
  if (assetPath) return readFileSync(assetPath);
  return Buffer.from(
    CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.bodyBase64,
    "base64",
  );
}

function assetResult() {
  return {
    path: options.bundlePath,
    contentType: "text/javascript",
    bodyBase64: assetBody.toString("base64"),
  };
}

function requireModule(params: JsonObject): void {
  if (params.moduleId !== moduleManifest.id) {
    throw new Error(`Unknown fixture module id: ${String(params.moduleId)}`);
  }
}

function requireAssetPath(params: JsonObject): void {
  if (params.path !== options.bundlePath) {
    throw new Error(`Unknown fixture asset path: ${String(params.path)}`);
  }
}

function parseArgs(args: string[]): Options {
  let host = "127.0.0.1";
  let port = 0;
  let token: string | undefined;
  let assetPath: string | undefined;
  let bundlePath = "/assets/fixture-view.js";
  let readyFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = () => {
      index += 1;
      return requireValue(args, index, arg);
    };
    if (arg === "--host") {
      host = nextValue();
    } else if (arg === "--port") {
      const value = Number.parseInt(nextValue(), 10);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }
      port = value;
    } else if (arg === "--token") {
      token = nextValue();
    } else if (arg === "--asset-path" || arg === "--bundle-file") {
      assetPath = resolve(nextValue());
    } else if (arg === "--bundle-path") {
      bundlePath = nextValue();
      if (!bundlePath.startsWith("/")) {
        throw new Error("--bundle-path must start with /.");
      }
    } else if (arg === "--ready-file") {
      readyFile = resolve(nextValue());
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    host,
    port,
    bundlePath,
    ...(token ? { token } : {}),
    ...(assetPath ? { assetPath } : {}),
    ...(readyFile ? { readyFile } : {}),
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function isAuthorized(
  request: IncomingMessage,
  token: string | undefined,
): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Usage: bun packages/scripts/capability-router-fixture-server.ts [options]

Options:
  --host <host>          Bind host (default: 127.0.0.1)
  --port <port>          Bind port, or 0 for an ephemeral port (default: 0)
  --token <token>        Require Authorization: Bearer <token>
  --asset-path <path>    Serve this JavaScript file as the fixture view bundle
  --bundle-file <path>   Alias for --asset-path
  --bundle-path <path>   Remote bundle path (default: /assets/fixture-view.js)
  --ready-file <path>    Write startup JSON to this file
`);
}
