/**
 * Pins the host-side x402 plugin TypeScript contract. The module is types-only
 * — these tests lock the exported shape (required payment helpers, optional
 * mobile-stub flag, optional startup validator) and drive real implementations
 * against it (wrap vs already-wrapped, unknown route, empty/single/multi route
 * queues, optional agentId). No live @elizaos/plugin-x402.
 */
import type {
  IAgentRuntime,
  LegacyRouteHandler,
  PaymentEnabledRoute,
  Route,
  RouteResponse,
} from "@elizaos/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { X402PluginModule } from "./x402-contract.ts";
import * as x402Contract from "./x402-contract.ts";

const noopHandler: LegacyRouteHandler = async () => undefined;

function captureResponse(): {
  res: RouteResponse;
  statuses: number[];
  bodies: unknown[];
} {
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const res: RouteResponse = {
    status(code) {
      statuses.push(code);
      return res;
    },
    json(data) {
      bodies.push(data);
      return res;
    },
    send(data) {
      bodies.push(data);
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, statuses, bodies };
}

function paymentRoute(
  overrides: {
    path?: string;
    type?: PaymentEnabledRoute["type"];
    x402?: PaymentEnabledRoute["x402"];
  } = {},
): PaymentEnabledRoute {
  const route: PaymentEnabledRoute = {
    type: overrides.type ?? "GET",
    path: overrides.path ?? "/paid",
    handler: noopHandler,
  };
  if (overrides.x402 !== undefined) {
    route.x402 = overrides.x402;
  }
  return route;
}

function trackingPlugin(options?: {
  __mobileStub?: boolean;
  withStartupValidator?: boolean;
}): X402PluginModule {
  const wrapped = new WeakSet<object>();
  const wrappedHandler: LegacyRouteHandler = async (_req, res) => {
    res.status(402).json({ paid: true });
  };
  const mod: X402PluginModule = {
    createPaymentAwareHandler: (route) => {
      wrapped.add(route);
      return wrappedHandler;
    },
    isRoutePaymentWrapped: (route) =>
      typeof route === "object" && route !== null && wrapped.has(route),
  };
  if (options?.__mobileStub !== undefined) {
    mod.__mobileStub = options.__mobileStub;
  }
  if (options?.withStartupValidator) {
    mod.validateX402Startup = (routes, character, startupOptions) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!Array.isArray(routes) || routes.length === 0) {
        warnings.push("empty-queue");
      }
      for (const route of routes) {
        if (route.x402 == null) {
          errors.push(`unpriced:${route.path}`);
        }
      }
      if (startupOptions.agentId === undefined) {
        warnings.push("missing-agent-id");
      }
      if (character == null) {
        warnings.push("missing-character");
      }
      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    };
  }
  return mod;
}

describe("x402-contract", () => {
  it("is types-only: none of the exported contracts exist at runtime", () => {
    expect(Object.keys(x402Contract)).toEqual([]);
    expect("X402PluginModule" in x402Contract).toBe(false);
  });
});

describe("X402PluginModule shape", () => {
  it("requires both payment helpers and keeps the stub flag and startup validator optional", () => {
    expectTypeOf<X402PluginModule>().toHaveProperty(
      "createPaymentAwareHandler",
    );
    expectTypeOf<X402PluginModule>().toHaveProperty("isRoutePaymentWrapped");
    expectTypeOf<X402PluginModule["__mobileStub"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<X402PluginModule["validateX402Startup"]>().toEqualTypeOf<
      | ((
          routes: Route[],
          character: unknown,
          options: { agentId?: string },
        ) => {
          valid: boolean;
          errors: string[];
          warnings: string[];
        })
      | undefined
    >();
  });

  it("types createPaymentAwareHandler as PaymentEnabledRoute → LegacyRouteHandler", () => {
    expectTypeOf<X402PluginModule["createPaymentAwareHandler"]>().toEqualTypeOf<
      (route: PaymentEnabledRoute) => LegacyRouteHandler
    >();
    expectTypeOf<
      Parameters<X402PluginModule["createPaymentAwareHandler"]>
    >().toEqualTypeOf<[PaymentEnabledRoute]>();
    expectTypeOf<
      ReturnType<X402PluginModule["createPaymentAwareHandler"]>
    >().toEqualTypeOf<LegacyRouteHandler>();
  });

  it("types isRoutePaymentWrapped as unknown → boolean", () => {
    expectTypeOf<X402PluginModule["isRoutePaymentWrapped"]>().toEqualTypeOf<
      (route: unknown) => boolean
    >();
  });

  it("does not treat a module missing a required helper as X402PluginModule", () => {
    expectTypeOf<{
      createPaymentAwareHandler: X402PluginModule["createPaymentAwareHandler"];
    }>().not.toMatchTypeOf<X402PluginModule>();
    expectTypeOf<{
      isRoutePaymentWrapped: X402PluginModule["isRoutePaymentWrapped"];
    }>().not.toMatchTypeOf<X402PluginModule>();
  });
});

describe("required payment helpers", () => {
  it("accepts a module with only the two required helpers", () => {
    const mod: X402PluginModule = {
      createPaymentAwareHandler: () => noopHandler,
      isRoutePaymentWrapped: () => false,
    };
    expect(typeof mod.createPaymentAwareHandler).toBe("function");
    expect(typeof mod.isRoutePaymentWrapped).toBe("function");
    expect(mod.__mobileStub).toBeUndefined();
    expect(mod.validateX402Startup).toBeUndefined();
  });

  it("wraps a priced route once and reports it as payment-wrapped", async () => {
    const mod = trackingPlugin();
    const route = paymentRoute({ x402: true });
    expect(mod.isRoutePaymentWrapped(route)).toBe(false);

    const wrapped = mod.createPaymentAwareHandler(route);
    expect(mod.isRoutePaymentWrapped(route)).toBe(true);
    expect(wrapped).not.toBe(noopHandler);

    const { res, statuses, bodies } = captureResponse();
    await wrapped({}, res, {} as IAgentRuntime);
    expect(statuses).toEqual([402]);
    expect(bodies).toEqual([{ paid: true }]);
  });

  it("does not report a different route as wrapped after wrapping one", () => {
    const mod = trackingPlugin();
    const first = paymentRoute({ path: "/paid-a", x402: true });
    const second = paymentRoute({ path: "/paid-b", x402: true });
    mod.createPaymentAwareHandler(first);
    expect(mod.isRoutePaymentWrapped(first)).toBe(true);
    expect(mod.isRoutePaymentWrapped(second)).toBe(false);
  });

  it("treats a missing or non-object route as not wrapped", () => {
    const mod = trackingPlugin();
    expect(mod.isRoutePaymentWrapped(undefined)).toBe(false);
    expect(mod.isRoutePaymentWrapped(null)).toBe(false);
    expect(mod.isRoutePaymentWrapped("/paid")).toBe(false);
    expect(mod.isRoutePaymentWrapped(0)).toBe(false);
    expect(mod.isRoutePaymentWrapped({ path: "/unknown" })).toBe(false);
  });
});

describe("optional __mobileStub", () => {
  it("leaves __mobileStub absent by default so a real plugin is distinguishable from the mobile null stub", () => {
    const mod = trackingPlugin();
    expect(mod.__mobileStub).toBeUndefined();
  });

  it("accepts an explicit __mobileStub flag without dropping the required helpers", () => {
    const stub = trackingPlugin({ __mobileStub: true });
    const live = trackingPlugin({ __mobileStub: false });
    expect(stub.__mobileStub).toBe(true);
    expect(live.__mobileStub).toBe(false);
    expect(typeof stub.createPaymentAwareHandler).toBe("function");
    expect(typeof stub.isRoutePaymentWrapped).toBe("function");
  });
});

describe("optional validateX402Startup", () => {
  it("returns valid with a warning for an empty route queue", () => {
    const mod = trackingPlugin({ withStartupValidator: true });
    expect(mod.validateX402Startup).toBeDefined();
    expect(
      mod.validateX402Startup?.([], { name: "agent" }, { agentId: "a1" }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: ["empty-queue"],
    });
  });

  it("accepts a single priced route and flags an unpriced sibling", () => {
    const mod = trackingPlugin({ withStartupValidator: true });
    const priced = paymentRoute({ path: "/paid", x402: true });
    const free = paymentRoute({ path: "/free" });
    expect(
      mod.validateX402Startup?.([priced], { name: "agent" }, { agentId: "a1" }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect(
      mod.validateX402Startup?.(
        [priced, free],
        { name: "agent" },
        { agentId: "a1" },
      ),
    ).toEqual({
      valid: false,
      errors: ["unpriced:/free"],
      warnings: [],
    });
  });

  it("warns when agentId is omitted and when character is missing, without failing the queue", () => {
    const mod = trackingPlugin({ withStartupValidator: true });
    const priced = paymentRoute({ x402: true });
    expect(mod.validateX402Startup?.([priced], { name: "agent" }, {})).toEqual({
      valid: true,
      errors: [],
      warnings: ["missing-agent-id"],
    });
    expect(
      mod.validateX402Startup?.([priced], null, { agentId: "a1" }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: ["missing-character"],
    });
  });
});
