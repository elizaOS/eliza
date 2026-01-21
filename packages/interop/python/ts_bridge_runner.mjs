#!/usr/bin/env node

/**
 * TypeScript Plugin Bridge Runner for Python
 *
 * Loads a TypeScript/JavaScript plugin and communicates with Python via
 * newline-delimited JSON messages over stdin/stdout.
 *
 * This file is intentionally committed (not generated at runtime) to avoid
 * “performative” behavior and to make audits/reviews reproducible.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const pluginPath = process.argv[2];
if (!pluginPath) {
  process.stderr.write("Usage: ts_bridge_runner.mjs <plugin_path>\n");
  process.exit(1);
}

const INCLUDE_DETAILS =
  ["1", "true", "yes", "on"].includes(
    String(process.env.ELIZA_INTEROP_DEBUG ?? process.env.LOG_DIAGNOSTIC ?? "")
      .trim()
      .toLowerCase(),
  ) || false;

const MAX_MESSAGE_BYTES = Number.parseInt(
  String(process.env.ELIZA_INTEROP_MAX_MESSAGE_BYTES ?? "1000000"),
  10,
);
const MAX_BUFFER_BYTES = Number.parseInt(
  String(process.env.ELIZA_INTEROP_MAX_BUFFER_BYTES ?? "2000000"),
  10,
);

/** @param {string} s */
function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

/** @param {unknown} error */
function formatError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: INCLUDE_DETAILS ? error.stack : undefined,
      name: INCLUDE_DETAILS ? error.name : undefined,
    };
  }
  return { message: String(error) };
}

async function loadPlugin(absPath) {
  // Prefer ESM import, fall back to CJS require.
  try {
    const mod = await import(absPath);
    return mod.default ?? mod.plugin ?? mod;
  } catch (_e) {
    const require = createRequire(import.meta.url);
    const mod = require(absPath);
    return mod.default ?? mod.plugin ?? mod;
  }
}

function indexByName(items) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const item of items ?? []) {
    if (item && typeof item.name === "string") out[item.name] = item;
  }
  return out;
}

function buildManifest(plugin, actions, providers, evaluators) {
  return {
    name: plugin?.name ?? "unknown",
    description: plugin?.description ?? "",
    version: plugin?.version ?? "1.0.0",
    language: "typescript",
    config: plugin?.config,
    dependencies: plugin?.dependencies,
    actions: Object.values(actions).map((a) => ({
      name: a.name,
      description: a.description,
      similes: a.similes,
    })),
    providers: Object.values(providers).map((p) => ({
      name: p.name,
      description: p.description,
      dynamic: p.dynamic,
      position: p.position,
      private: p.private,
    })),
    evaluators: Object.values(evaluators).map((e) => ({
      name: e.name,
      description: e.description,
      alwaysRun: e.alwaysRun,
      similes: e.similes,
    })),
  };
}

/**
 * @param {any} request
 * @param {any} plugin
 * @param {Record<string, any>} actions
 * @param {Record<string, any>} providers
 * @param {Record<string, any>} evaluators
 */
async function handleRequest(request, plugin, actions, providers, evaluators) {
  const type = request?.type;
  const id = request?.id ?? "";

  try {
    switch (type) {
      case "plugin.init": {
        if (typeof plugin?.init === "function") {
          await plugin.init(request.config ?? {}, null);
        }
        return { type: "plugin.init.result", id, success: true };
      }

      case "action.validate": {
        const action = actions[request.action];
        if (!action || typeof action.validate !== "function") {
          return { type: "validate.result", id, valid: false };
        }
        const valid = await action.validate(
          null,
          request.memory,
          request.state,
        );
        return { type: "validate.result", id, valid: Boolean(valid) };
      }

      case "action.invoke": {
        const action = actions[request.action];
        if (!action || typeof action.handler !== "function") {
          return {
            type: "action.result",
            id,
            result: {
              success: false,
              error: `Action not found: ${request.action}`,
            },
          };
        }
        const result = await action.handler(
          null,
          request.memory,
          request.state,
          request.options ?? null,
          null,
          null,
        );
        return {
          type: "action.result",
          id,
          result: {
            success: Boolean(result?.success ?? true),
            text: result?.text ?? null,
            error: result?.error?.message ?? result?.error ?? null,
            data: result?.data ?? null,
            values: result?.values ?? null,
          },
        };
      }

      case "provider.get": {
        const provider = providers[request.provider];
        if (!provider || typeof provider.get !== "function") {
          return {
            type: "provider.result",
            id,
            result: { text: null, values: null, data: null },
          };
        }
        const result = await provider.get(null, request.memory, request.state);
        return {
          type: "provider.result",
          id,
          result: result ?? { text: null, values: null, data: null },
        };
      }

      case "evaluator.invoke": {
        const evaluator = evaluators[request.evaluator];
        if (!evaluator || typeof evaluator.handler !== "function") {
          return { type: "action.result", id, result: null };
        }
        const result = await evaluator.handler(
          null,
          request.memory,
          request.state,
        );
        return {
          type: "action.result",
          id,
          result: result
            ? {
                success: Boolean(result.success ?? true),
                text: result.text ?? null,
                error: result.error?.message ?? result.error ?? null,
                data: result.data ?? null,
                values: result.values ?? null,
              }
            : null,
        };
      }

      default:
        return {
          type: "error",
          id,
          error: `Unknown request type: ${String(type)}`,
        };
    }
  } catch (e) {
    return {
      type: "error",
      id,
      error: formatError(e).message,
      details: INCLUDE_DETAILS ? formatError(e) : undefined,
    };
  }
}

(async () => {
  const absPath = resolve(pluginPath);
  const plugin = await loadPlugin(absPath);

  const actions = indexByName(plugin?.actions);
  const providers = indexByName(plugin?.providers);
  const evaluators = indexByName(plugin?.evaluators);

  const manifest = buildManifest(plugin, actions, providers, evaluators);

  process.stdout.write(`${JSON.stringify({ type: "ready", manifest })}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let bufferedBytes = 0;
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const len = byteLen(trimmed);
    if (len > MAX_MESSAGE_BYTES) {
      process.stderr.write(`IPC message too large (${len} bytes)\n`);
      process.exit(2);
    }

    bufferedBytes += len;
    if (bufferedBytes > MAX_BUFFER_BYTES) {
      process.stderr.write("IPC buffer exceeded limit\n");
      process.exit(2);
    }

    /** @type {any} */
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (e) {
      // Protocol violation: fail closed.
      process.stderr.write(`Invalid JSON from stdin: ${String(e)}\n`);
      process.exit(2);
      return;
    } finally {
      bufferedBytes -= len;
    }

    const response = await handleRequest(
      request,
      plugin,
      actions,
      providers,
      evaluators,
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
})();
