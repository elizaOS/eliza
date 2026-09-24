/**
 * Enforces loopback-only fetches inside the scenario subprocess and records an
 * append-only ledger. Real model calls must traverse the controller's loopback
 * proxy; direct provider or service egress is rejected before bytes are sent.
 */

import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

const ledgerPath = process.env.ELIZA_STABILITY_CHILD_NETWORK_LEDGER;
if (!ledgerPath) throw new Error("network guard requires its ledger path");
const nativeFetch = globalThis.fetch;
const loopback = (hostname: string) => {
  if (hostname === "localhost") return true;
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return (
    address === "::1" ||
    (isIP(address) === 4 && address.split(".", 1)[0] === "127")
  );
};

const appendDecision = (url: URL, method: string, allowed: boolean) => {
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      origin: url.origin,
      method,
      allowed,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

function isOptions(value: unknown): value is http.RequestOptions {
  return value !== null && typeof value === "object" && !(value instanceof URL);
}

const requestUrl = (defaultProtocol: string, args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return new URL(first);
  if (!isOptions(first) || first.socketPath) {
    throw new Error("stability network policy requires an explicit HTTP URL");
  }
  const protocol = first.protocol ?? defaultProtocol;
  const rawHostname = first.hostname;
  let authority;
  if (typeof rawHostname === "string" && rawHostname.length > 0) {
    const hostname = isIP(rawHostname) === 6 ? `[${rawHostname}]` : rawHostname;
    authority = `${hostname}${first.port ? `:${String(first.port)}` : ""}`;
  } else if (typeof first.host === "string" && first.host.length > 0) {
    authority = first.host;
  } else {
    throw new Error("stability network policy requires an explicit HTTP host");
  }
  const rawPath = typeof first.path === "string" ? first.path : "/";
  const pathname = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return new URL(`${protocol}//${authority}${pathname}`);
};

const requestMethod = (args: unknown[]) => {
  const first = args[0];
  const second = args[1];
  const options = isOptions(second)
    ? second
    : isOptions(first)
      ? first
      : undefined;
  return options?.method ?? "GET";
};

const guardRequestModule = (
  module: Pick<typeof http, "request" | "get">,
  defaultProtocol: string,
) => {
  const nativeRequest = module.request;
  module.request = function guardedRequest(...args: unknown[]) {
    const url = requestUrl(defaultProtocol, args);
    const method = requestMethod(args);
    const allowed = loopback(url.hostname);
    appendDecision(url, method, allowed);
    if (!allowed)
      throw new Error(`stability network policy blocked ${url.origin}`);
    return Reflect.apply(nativeRequest, module, args);
  };
  module.get = function guardedGet(...args: unknown[]) {
    const request: http.ClientRequest = Reflect.apply(
      module.request,
      module,
      args,
    );
    request.end();
    return request;
  };
};

guardRequestModule(http, "http:");
guardRequestModule(https, "https:");
syncBuiltinESMExports();
mock.module("node:http", () => ({
  ...http,
  default: http,
  request: http.request,
  get: http.get,
}));
mock.module("node:https", () => ({
  ...https,
  default: https,
  request: https.request,
  get: https.get,
}));

const guardedFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const allowed = loopback(url.hostname);
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  appendDecision(url, method, allowed);
  if (!allowed)
    throw new Error(`stability network policy blocked ${url.origin}`);
  const response = await nativeFetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("loopback redirect omitted Location");
    const target = new URL(location, url);
    const targetAllowed = loopback(target.hostname);
    appendDecision(target, method, targetAllowed);
    if (!targetAllowed) {
      throw new Error(
        `stability network policy blocked redirect ${target.origin}`,
      );
    }
    throw new Error(
      `stability network policy blocked redirect ${target.origin}`,
    );
  }
  return response;
};

// Preserve Bun's fetch API while applying the same egress boundary to warmups.
globalThis.fetch = Object.assign(guardedFetch, {
  preconnect: (
    input: Parameters<typeof fetch.preconnect>[0],
    options?: Parameters<typeof fetch.preconnect>[1],
  ) => {
    const url = new URL(input);
    const allowed = loopback(url.hostname);
    appendDecision(url, "PRECONNECT", allowed);
    if (!allowed)
      throw new Error(`stability network policy blocked ${url.origin}`);
    return nativeFetch.preconnect(input, options);
  },
});
