/**
 * Unit coverage for the x402 payment-guard helpers in `dispatch-route.ts`
 * (`vetX402Module` / `selectX402Handler`): only a module exposing both payment
 * helpers wraps a priced route, missing plugins and the mobile null stub fall
 * through to the unwrapped handler, and an already-wrapped route is not
 * double-wrapped. Loads the real mobile null-plugin stub artifact, not a fake.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { LegacyRouteHandler, Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { selectX402Handler, vetX402Module } from "./dispatch-route.ts";

// The real null stub the mobile bundle aliases @elizaos/plugin-x402 to. Loading
// the actual artifact (not a hand-rolled fake) keeps this test honest: if the
// stub's shape changes, the guard's detection must still hold.
const require = createRequire(import.meta.url);
const mobileStub = require(
  fileURLToPath(
    new URL("../../scripts/mobile-stubs/null-plugin.cjs", import.meta.url),
  ),
);

const legacyHandler: LegacyRouteHandler =
  (async () => {}) as LegacyRouteHandler;

function x402Route(): Route {
  return {
    path: "/paid",
    type: "GET",
    handler: legacyHandler,
    x402: { price: "$0.01" },
  } as unknown as Route;
}

describe("dispatch-route x402 guard (item 10)", () => {
  describe("vetX402Module", () => {
    it("rejects a missing plugin (null)", () => {
      expect(vetX402Module(null)).toBeNull();
      expect(vetX402Module(undefined)).toBeNull();
    });

    it("rejects the real mobile null stub via __mobileStub", () => {
      // Sanity: the stub exposes the flag and its 'functions' return undefined.
      expect((mobileStub as { __mobileStub?: boolean }).__mobileStub).toBe(
        true,
      );
      expect(mobileStub.createPaymentAwareHandler()).toBeUndefined();
      expect(vetX402Module(mobileStub)).toBeNull();
    });

    it("rejects a module missing the payment helpers", () => {
      expect(vetX402Module({})).toBeNull();
      expect(vetX402Module({ createPaymentAwareHandler: () => {} })).toBeNull();
    });

    it("accepts a module exposing both payment helpers", () => {
      const mod = {
        createPaymentAwareHandler: () => legacyHandler,
        isRoutePaymentWrapped: () => false,
      };
      expect(vetX402Module(mod)).toBe(mod);
    });
  });

  describe("selectX402Handler", () => {
    it("falls through to the unwrapped handler when x402 is unavailable", () => {
      // Plugin absent OR mobile stub: no unhandled TypeError, deliberate
      // fall-through to the route's own handler.
      expect(selectX402Handler(null, x402Route(), legacyHandler)).toBe(
        legacyHandler,
      );
    });

    it("wraps the handler when x402 is present and route is not yet wrapped", () => {
      const wrapped = (async () => {}) as LegacyRouteHandler;
      let wrapCalls = 0;
      const mod = {
        isRoutePaymentWrapped: () => false,
        createPaymentAwareHandler: () => {
          wrapCalls++;
          return wrapped;
        },
      } as unknown as typeof import("@elizaos/plugin-x402");
      const result = selectX402Handler(mod, x402Route(), legacyHandler);
      expect(result).toBe(wrapped);
      expect(wrapCalls).toBe(1);
    });

    it("does not double-wrap an already payment-wrapped route", () => {
      const mod = {
        isRoutePaymentWrapped: () => true,
        createPaymentAwareHandler: () => {
          throw new Error("should not wrap an already-wrapped route");
        },
      } as unknown as typeof import("@elizaos/plugin-x402");
      expect(selectX402Handler(mod, x402Route(), legacyHandler)).toBe(
        legacyHandler,
      );
    });
  });
});
