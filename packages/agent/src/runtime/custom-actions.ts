/**
 * Custom Actions runtime loader.
 *
 * Converts `CustomActionDef[]` from config into elizaOS `Action[]` objects
 * so the agent can use them in conversations.
 *
 * @module runtime/custom-actions
 */

import { lookup as dnsLookup } from "node:dns/promises";
import {
  type RequestOptions as HttpRequestOptions,
  type IncomingMessage,
  request as requestHttp,
} from "node:http";
import { request as requestHttps } from "node:https";
import net from "node:net";
import {
  type Action,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { resolveApiToken, resolveServerOnlyPort } from "@elizaos/shared";
import { hasSelectedContextOrSignalSync } from "../actions/context-signal.js";
import { loadElizaConfig } from "../config/config.js";
import type {
  CustomActionDef,
  CustomActionHandler,
} from "../config/types.eliza.js";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.js";

/** Cached runtime reference for hot-registration of new actions. */
let _runtime: IAgentRuntime | null = null;

/**
 * Store the runtime reference so we can hot-register actions later.
 * Called once from plugin.init().
 */
export function setCustomActionsRuntime(runtime: IAgentRuntime): void {
  _runtime = runtime;
}

/**
 * Hot-register a CustomActionDef into the running agent.
 * Returns the elizaOS Action that was registered, or null if no runtime.
 */
export function registerCustomActionLive(def: CustomActionDef): Action | null {
  if (!_runtime) return null;
  const action = defToAction(def);
  _runtime.registerAction(action);
  return action;
}

/** Valid handler types that we actually support. */
const VALID_HANDLER_TYPES = new Set(["http", "shell", "code"]);

type VmRunner = {
  runInNewContext: (
    code: string,
    contextObject: Record<string, unknown>,
    options?: { filename?: string; timeout?: number },
  ) => unknown;
};

let vmRunner: VmRunner | null = null;

const CUSTOM_ACTION_FETCH_TIMEOUT_MS = 15_000;
const CUSTOM_ACTION_SHELL_TIMEOUT_MS = 30_000;
const CUSTOM_ACTION_CONTEXTS = [
  "general",
  "automation",
  "connectors",
  "agent_internal",
] as const;

export class CustomActionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomActionTimeoutError";
  }
}

type ResolvedUrlTarget = {
  parsed: URL;
  hostname: string;
  pinnedAddress: string;
};

type PinnedFetchInput = {
  url: URL;
  init: RequestInit;
  target: ResolvedUrlTarget;
  timeoutMs: number;
};

type PinnedFetchImpl = (input: PinnedFetchInput) => Promise<Response>;

function getApiPort(): string {
  return String(resolveServerOnlyPort(process.env));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutMessage = `Terminal request timed out after ${timeoutMs}ms`;

  return await new Promise<Response>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      if (settled) return;
      settled = true;
      reject(new CustomActionTimeoutError(timeoutMessage));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    fetch(input, {
      ...init,
      signal: controller.signal,
    }).then(
      (response) => settle(() => resolve(response)),
      (error) => {
        if (controller.signal.aborted) {
          settle(() => reject(new CustomActionTimeoutError(timeoutMessage)));
          return;
        }
        settle(() => reject(error));
      },
    );
  });
}

function resolveFetchInputUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

async function safeCodeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = resolveFetchInputUrl(input);
  if (!url) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }

  const safety = await resolveUrlSafety(url);
  if (safety.blocked) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }

  const requestInit = await buildPinnedFetchInit(input, init);
  const response = safety.target
    ? await fetchWithPinnedTarget(
        safety.target,
        requestInit,
        CUSTOM_ACTION_FETCH_TIMEOUT_MS,
      )
    : await fetch(input, requestInit);
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      "Blocked: redirects are not allowed for code custom actions",
    );
  }

  return response;
}

async function runCodeHandler(
  code: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("Code actions are only supported in Node runtimes.");
  }

  if (!vmRunner) {
    vmRunner = (await import("node:vm")) as VmRunner;
  }

  const script = `(async () => { ${code} })();`;
  const context: Record<string, unknown> = Object.create(null);
  context.params = Object.freeze({ ...params });

  const wrapperScript = `(function(hostFetch) {
    return function fetch(input, init) { return hostFetch(input, init); };
  })`;
  const wrapFetch = vmRunner.runInNewContext(
    wrapperScript,
    Object.create(null),
    {
      filename: "eliza-fetch-wrapper",
      timeout: 1_000,
    },
  ) as (fn: typeof safeCodeFetch) => typeof safeCodeFetch;
  context.fetch = wrapFetch(safeCodeFetch);

  return await vmRunner.runInNewContext(`"use strict"; ${script}`, context, {
    filename: "eliza-custom-action",
    timeout: 30_000,
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isBlockedIp(ip: string): boolean {
  return isBlockedPrivateOrLinkLocalIp(ip);
}

function toRequestHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

async function toRequestBodyBuffer(
  body: BodyInit | null | undefined,
): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Unsupported request body type for custom action fetch");
}

function incomingMessageBody(
  response: IncomingMessage,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : new Uint8Array(chunk),
        );
      });
      response.on("end", () => controller.close());
      response.on("error", (error) => controller.error(error));
    },
    cancel() {
      response.destroy();
    },
  });
}

function responseFromIncomingMessage(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const status = response.statusCode ?? 500;
  const body =
    status === 204 || status === 205 || status === 304
      ? null
      : incomingMessageBody(response);

  return new Response(body, {
    status,
    statusText: response.statusMessage,
    headers,
  });
}

async function requestWithPinnedAddress(
  input: PinnedFetchInput,
): Promise<Response> {
  const { url, init, target, timeoutMs } = input;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const bodyBuffer = await toRequestBodyBuffer(
    init.body as BodyInit | undefined,
  );
  if (bodyBuffer && !headers.has("content-length")) {
    headers.set("content-length", String(bodyBuffer.byteLength));
  }

  const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
  const family = net.isIP(target.pinnedAddress) === 6 ? 6 : 4;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const signal = init.signal;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      request.destroy(new DOMException("Aborted", "AbortError"));
    };

    const requestOptions: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: target.hostname,
      port: url.port ? Number(url.port) : undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers: toRequestHeaders(headers),
      lookup: (_hostname, _options, callback) => {
        callback(null, target.pinnedAddress, family);
      },
      ...(url.protocol === "https:"
        ? { servername: target.hostname }
        : undefined),
    };

    const request = requestFn(requestOptions, (response) => {
      settle(() => resolve(responseFromIncomingMessage(response)));
    });

    request.on("error", (error) => {
      settle(() => reject(error));
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    timeoutHandle = setTimeout(() => {
      request.destroy(
        new Error(`Custom action request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    if (bodyBuffer) {
      request.write(bodyBuffer);
    }
    request.end();
  });
}

let pinnedFetchImpl: PinnedFetchImpl = requestWithPinnedAddress;

export function __setPinnedFetchImplForTests(
  impl: PinnedFetchImpl | null,
): void {
  pinnedFetchImpl = impl ?? requestWithPinnedAddress;
}

async function resolveUrlSafety(url: string): Promise<{
  blocked: boolean;
  target: ResolvedUrlTarget | null;
}> {
  try {
    const parsed = new URL(url);
    const hostname = normalizeHostLike(parsed.hostname);
    if (!hostname) return { blocked: true, target: null };

    if (
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1") &&
      parsed.port === getApiPort()
    ) {
      return { blocked: false, target: null };
    }

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname === "[::1]" ||
      hostname === "metadata.google.internal" ||
      hostname === "169.254.169.254"
    ) {
      return { blocked: true, target: null };
    }

    if (net.isIP(hostname)) {
      if (isBlockedIp(hostname)) return { blocked: true, target: null };
      return {
        blocked: false,
        target: {
          parsed,
          hostname,
          pinnedAddress: hostname,
        },
      };
    }

    const records = await dnsLookup(hostname, { all: true });
    const addresses = Array.isArray(records) ? records : [records];
    for (const entry of addresses) {
      if (isBlockedIp(entry.address)) {
        return { blocked: true, target: null };
      }
    }

    return {
      blocked: false,
      target: {
        parsed,
        hostname,
        pinnedAddress: addresses[0]?.address ?? "",
      },
    };
  } catch {
    return { blocked: true, target: null };
  }
}

async function buildPinnedFetchInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RequestInit> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) {
      const overrideHeaders = new Headers(init.headers);
      overrideHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    const method = init?.method ?? input.method;
    const bodyFromInit = init?.body;
    const bodyFromRequest =
      bodyFromInit !== undefined
        ? undefined
        : method === "GET" || method === "HEAD"
          ? undefined
          : await input.clone().arrayBuffer();

    return {
      ...init,
      method,
      headers,
      body: bodyFromInit ?? bodyFromRequest,
      signal: init?.signal ?? input.signal,
      redirect: "manual",
    };
  }

  return {
    ...init,
    redirect: "manual",
  };
}

async function fetchWithPinnedTarget(
  target: ResolvedUrlTarget,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!target.pinnedAddress) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }
  return pinnedFetchImpl({
    url: target.parsed,
    init,
    target,
    timeoutMs,
  });
}

function buildHandler(
  handler: CustomActionHandler,
  paramDefs: CustomActionDef["parameters"],
): (
  params: Record<string, string>,
) => Promise<{ ok: boolean; output: string }> {
  if (!VALID_HANDLER_TYPES.has(handler.type)) {
    return async () => ({
      ok: false,
      output: `Unsupported handler type: ${handler.type}`,
    });
  }

  switch (handler.type) {
    case "http":
      return async (params) => {
        let url = handler.url;
        let body = handler.bodyTemplate ?? "";
        const headers: Record<string, string> = { ...handler.headers };

        for (const p of paramDefs) {
          const value = params[p.name] ?? "";
          url = url.replaceAll(`{{${p.name}}}`, encodeURIComponent(value));
          body = body.replaceAll(`{{${p.name}}}`, value);
        }

        const safety = await resolveUrlSafety(url);
        if (safety.blocked) {
          return {
            ok: false,
            output:
              "Blocked: cannot make requests to internal network addresses",
          };
        }

        if (!headers["Content-Type"] && body) {
          headers["Content-Type"] = "application/json";
        }

        const fetchOpts: RequestInit = {
          method: handler.method || "GET",
          headers,
          redirect: "manual",
        };
        if (body && handler.method !== "GET" && handler.method !== "HEAD") {
          fetchOpts.body = body;
        }

        const response = safety.target
          ? await fetchWithPinnedTarget(
              safety.target,
              fetchOpts,
              CUSTOM_ACTION_FETCH_TIMEOUT_MS,
            )
          : await fetch(url, fetchOpts);
        if (response.status >= 300 && response.status < 400) {
          return {
            ok: false,
            output:
              "Blocked: redirects are not allowed for HTTP custom actions",
          };
        }
        const text = await response.text();
        return { ok: response.ok, output: text.slice(0, 4000) };
      };

    case "shell":
      return async (params) => {
        let command = handler.command;
        for (const p of paramDefs) {
          const value = params[p.name] ?? "";
          command = command.replaceAll(`{{${p.name}}}`, shellEscape(value));
        }

        const response = await fetchWithTimeout(
          `http://localhost:${getApiPort()}/api/terminal/run`,
          {
            method: "POST",
            headers: (() => {
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const token = resolveApiToken(process.env);
              if (token) {
                headers.Authorization = /^Bearer\s+/i.test(token)
                  ? token
                  : `Bearer ${token}`;
              }
              return headers;
            })(),
            body: JSON.stringify({
              command,
              clientId: "runtime-shell-action",
            }),
          },
          CUSTOM_ACTION_SHELL_TIMEOUT_MS,
        );

        if (!response.ok) {
          return {
            ok: false,
            output: `Terminal request failed: HTTP ${response.status}`,
          };
        }

        return { ok: true, output: `Executed: ${command}` };
      };

    case "code":
      return async (params) => {
        const result = await runCodeHandler(handler.code, params);
        const output = result !== undefined ? String(result) : "Done";
        return { ok: true, output: output.slice(0, 4000) };
      };

    default:
      return async () => ({ ok: false, output: "Unknown handler type" });
  }
}

function defToAction(def: CustomActionDef): Action {
  const handler = buildHandler(def.handler, def.parameters);
  const validationTerms = [
    def.name,
    ...(def.similes ?? []),
    ...def.name.split(/[_\s-]+/),
    ...(def.description ?? "").split(/[\s,.;:()[\]{}'"`/\\-]+/),
  ].filter((term) => term.trim().length > 2);

  return {
    name: def.name,
    contexts: [...CUSTOM_ACTION_CONTEXTS],
    roleGate:
      def.requiredRole && def.requiredRole !== "GUEST"
        ? { minRole: def.requiredRole }
        : { minRole: "USER" },
    similes: def.similes ?? [],
    description: def.description,
    validate: async (_runtime, message, state) => {
      return hasSelectedContextOrSignalSync(
        message,
        state,
        CUSTOM_ACTION_CONTEXTS,
        validationTerms,
      );
    },

    handler: async (_runtime, _message, _state, options) => {
      try {
        const opts = options as HandlerOptions | undefined;
        const params: Record<string, string> = {};

        for (const p of def.parameters) {
          const value = opts?.parameters?.[p.name];
          if (typeof value === "string") {
            params[p.name] = value;
          } else if (value !== undefined && value !== null) {
            params[p.name] = String(value);
          } else if (p.required) {
            return {
              text: `Missing required parameter: ${p.name}`,
              success: false,
            };
          }
        }

        const result = await handler(params);
        return {
          text: result.output,
          success: result.ok,
          data: { actionId: def.id, params },
        };
      } catch (err) {
        return {
          text: `Action failed: ${String(err)}`,
          success: false,
        };
      }
    },

    parameters: def.parameters.map((p) => ({
      name: p.name,
      description: p.description,
      required: p.required,
      schema: { type: "string" as const },
    })),
  };
}

export function loadCustomActions(): Action[] {
  try {
    const config = loadElizaConfig();
    const defs = config.customActions ?? [];
    return defs.filter((d) => d.enabled).map(defToAction);
  } catch (err) {
    logger.warn(
      `[custom-actions] Failed to load custom actions from config: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

export function buildTestHandler(
  def: CustomActionDef,
): (
  params: Record<string, string>,
) => Promise<{ ok: boolean; output: string }> {
  return buildHandler(def.handler, def.parameters);
}
