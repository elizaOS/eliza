/** Exercises unsupported SSH construction and helper access through the real Worker shim. */
import { expect, test } from "vitest";
import { Client, Server, utils } from "./ssh2";

test.each([
  ["Client", Client],
  ["Server", Server],
] as const)("SSH %s rejects Worker construction", (_name, Constructor) => {
  expect(() => new Constructor()).toThrow(
    /not available on Cloudflare Workers/,
  );
});

test("SSH key parsing rejects Worker helper access", () => {
  expect(() => Reflect.get(utils, "parseKey")).toThrow(
    /not available on Cloudflare Workers/,
  );
});
