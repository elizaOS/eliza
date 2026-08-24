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
const loopback = (hostname) => {
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

const appendDecision = (url, method, allowed) => {
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

const requestUrl = (defaultProtocol, args) => {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return new URL(first);
  if (!first || typeof first !== "object" || first.socketPath) {
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

const requestMethod = (args) => {
  const first = args[0];
  const second = args[1];
  const options =
    second && typeof second === "object"
      ? second
      : first && typeof first === "object" && !(first instanceof URL)
        ? first
        : undefined;
  return options?.method ?? "GET";
};

const guardRequestModule = (module, defaultProtocol) => {
  const nativeRequest = module.request;
  module.request = function guardedRequest(...args) {
    const url = requestUrl(defaultProtocol, args);
    const method = requestMethod(args);
    const allowed = loopback(url.hostname);
    appendDecision(url, method, allowed);
    if (!allowed)
      throw new Error(`stability network policy blocked ${url.origin}`);
    return Reflect.apply(nativeRequest, module, args);
  };
  module.get = function guardedGet(...args) {
    const request = module.request(...args);
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

globalThis.fetch = async (input, init) => {
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
