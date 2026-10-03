/** Exercises native fetch delegation and unsupported undici operations through the real Worker shim. */
import { expect, test } from "vitest";
import * as undici from "./undici";

test("reads a response through the shim Request and native fetch", async () => {
  const response = await undici.fetch(
    new undici.Request("data:text/plain,worker-response"),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("worker-response");
});

test("rejects an aborted request without opening a network socket", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new undici.Request("https://example.com/", {
    signal: controller.signal,
  });
  await expect(undici.fetch(request)).rejects.toThrow();
});

test("rejects invalid fetch URLs", async () => {
  await expect(undici.fetch("not-a-url")).rejects.toBeInstanceOf(TypeError);
});

test.each([
  "Agent",
  "Pool",
  "Dispatcher",
  "ProxyAgent",
  "MockAgent",
  "MockPool",
  "Client",
  "BalancedPool",
  "RetryAgent",
  "EnvHttpProxyAgent",
] as const)("undici %s rejects unsupported Worker construction", (name) => {
  expect(() => new undici[name]()).toThrow(
    /not available on Cloudflare Workers/,
  );
});

test("does not install a custom global dispatcher", () => {
  Reflect.apply(undici.setGlobalDispatcher, undefined, [{}]);
  expect(undici.getGlobalDispatcher).toThrow(
    /not available on Cloudflare Workers/,
  );
});

test("does not retain a custom global origin", () => {
  Reflect.apply(undici.setGlobalOrigin, undefined, ["https://example.com"]);
  expect(undici.getGlobalOrigin()).toBeUndefined();
});
