/**
 * Unit tests for the remote-capability endpoint conformance harness against a
 * mocked capability-router `fetch` backed by the shared protocol fixture.
 * Verify the happy path exercises every surface, that missing/weak evidence and
 * mismatched view-asset content type/integrity fail, and that required surfaces
 * spread and backfill across multiple modules.
 */
import { createHash } from "node:crypto";
import { CAPABILITY_ROUTER_PROTOCOL_FIXTURE } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRemoteCapabilityEndpointConformance } from "./remote-capability-endpoint-conformance.ts";

const originalFetch = globalThis.fetch;

describe("remote capability endpoint conformance", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exercises the standard plugin RPC surfaces through the capability-router client", async () => {
    const calls: Array<{ url: string; method?: string; params?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: Record<string, unknown>;
          })
        : undefined;
      calls.push({
        url: String(url),
        method: body?.method,
        params: body?.params,
      });
      if (String(url) === "https://remote.example.test/v1/capabilities") {
        return jsonResponse({
          environment: "server",
          available: true,
          capabilities: {
            fs: false,
            pty: false,
            git: false,
            model: false,
            plugin: true,
          },
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.modules.list"
      ) {
        return jsonResponse({
          ok: true,
          result: {
            modules: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module],
          },
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.action.invoke"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.provider.get"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.route.call"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.asset.get"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.model.invoke"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.lifecycle.call"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.event.handle"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.service.call"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service,
        });
      }
      if (
        String(url) === "https://remote.example.test/v1/capabilities/invoke" &&
        body?.method === "plugin.appBridge.call"
      ) {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge,
        });
      }
      if (String(url).endsWith("/v1/capabilities/invoke")) {
        const resultByMethod: Record<string, unknown> = {
          "plugin.evaluator.shouldRun":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun,
          "plugin.evaluator.prepare":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare,
          "plugin.evaluator.prompt":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt,
          "plugin.evaluator.process":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess,
          "plugin.responseHandlerEvaluator.shouldRun":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
              .responseHandlerEvaluatorShouldRun,
          "plugin.responseHandlerEvaluator.evaluate":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
              .responseHandlerEvaluatorEvaluate,
          "plugin.responseHandlerFieldEvaluator.shouldRun":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
              .responseHandlerFieldEvaluatorShouldRun,
          "plugin.responseHandlerFieldEvaluator.parse":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
              .responseHandlerFieldEvaluatorParse,
          "plugin.responseHandlerFieldEvaluator.handle":
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
              .responseHandlerFieldEvaluatorHandle,
        };
        if (body?.method && body.method in resultByMethod) {
          return jsonResponse({
            ok: true,
            result: resultByMethod[body.method],
          });
        }
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
          token: "remote-token",
        },
      }),
    ).resolves.toMatchObject({
      endpointId: "remote-endpoint",
      moduleCount: 1,
      moduleIds: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id],
      exercised: {
        action: "fixture-remote-plugin:FIXTURE_ACTION",
        provider: "fixture-remote-plugin:FIXTURE_CONTEXT",
        route: "fixture-remote-plugin:POST /fixture/route",
        viewAsset: "fixture-remote-plugin:/assets/fixture-view.js",
        model: "fixture-remote-plugin:TEXT_SMALL",
        lifecycle: "fixture-remote-plugin:init",
        event: "fixture-remote-plugin:fixture.event",
        service: "fixture-remote-plugin:fixture-service.ping",
        appBridge: "fixture-remote-plugin:prepareLaunch",
        evaluator: "fixture-remote-plugin:FIXTURE_EVALUATOR",
        responseHandlerEvaluator:
          "fixture-remote-plugin:FIXTURE_RESPONSE_EVALUATOR",
        responseHandlerFieldEvaluator:
          "fixture-remote-plugin:FIXTURE_FIELD_EVALUATOR",
      },
      actionResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
      providerResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider,
      routeResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route,
      assetResult: {
        path: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.path,
        contentType: "text/javascript",
        manifestContentType: "text/javascript",
        byteLength: Buffer.from(
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.bodyBase64,
          "base64",
        ).byteLength,
        sha256: createHash("sha256")
          .update(
            Buffer.from(
              CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.bodyBase64,
              "base64",
            ),
          )
          .digest("hex"),
      },
      modelResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model,
      lifecycleResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle,
      eventResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event,
      serviceResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service,
      appBridgeResult: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge,
      evaluatorResult: {
        shouldRun:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun,
        prepare: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare,
        prompt: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt,
        process: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess,
      },
      responseHandlerEvaluatorResult: {
        shouldRun:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
            .responseHandlerEvaluatorShouldRun,
        evaluate:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
            .responseHandlerEvaluatorEvaluate,
      },
      responseHandlerFieldEvaluatorResult: {
        shouldRun:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
            .responseHandlerFieldEvaluatorShouldRun,
        parse:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
            .responseHandlerFieldEvaluatorParse,
        handle:
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
            .responseHandlerFieldEvaluatorHandle,
      },
    });
    expect(calls.map((call) => call.method ?? "availability")).toEqual([
      "availability",
      "plugin.modules.list",
      "plugin.action.invoke",
      "plugin.provider.get",
      "plugin.route.call",
      "plugin.asset.get",
      "plugin.model.invoke",
      "plugin.lifecycle.call",
      "plugin.event.handle",
      "plugin.service.call",
      "plugin.appBridge.call",
      "plugin.evaluator.shouldRun",
      "plugin.evaluator.prepare",
      "plugin.evaluator.prompt",
      "plugin.evaluator.process",
      "plugin.responseHandlerEvaluator.shouldRun",
      "plugin.responseHandlerEvaluator.evaluate",
      "plugin.responseHandlerFieldEvaluator.shouldRun",
      "plugin.responseHandlerFieldEvaluator.parse",
      "plugin.responseHandlerFieldEvaluator.handle",
    ]);
  });

  it("fails when a required remote plugin surface is missing", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string })
        : undefined;
      if (String(url) === "https://remote.example.test/v1/capabilities") {
        return jsonResponse({
          environment: "server",
          available: true,
          capabilities: {
            fs: false,
            pty: false,
            git: false,
            model: false,
            plugin: true,
          },
        });
      }
      if (body?.method === "plugin.modules.list") {
        return jsonResponse({
          ok: true,
          result: {
            modules: [{ id: "remote-plugin", name: "@remote/conformance" }],
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["action"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" did not expose a remote action.',
    );
  });

  it("spreads conformance calls across modules when multiple modules expose required surfaces", async () => {
    installMinimalFixtureFetch(
      {
        "plugin.action.invoke":
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
        "plugin.provider.get":
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider,
      },
      {
        modules: [
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
          {
            ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
            id: "second-remote-plugin",
            name: "@remote/second-fixture",
          },
        ],
      },
    );

    const report = await assertRemoteCapabilityEndpointConformance({
      endpoint: {
        id: "remote-endpoint",
        baseUrl: "https://remote.example.test",
      },
      requiredSurfaces: ["action", "provider"],
    });

    expect(new Set(Object.values(report.exercised))).toEqual(
      new Set([
        "fixture-remote-plugin:FIXTURE_ACTION",
        "second-remote-plugin:FIXTURE_CONTEXT",
      ]),
    );
  });

  it("adds module exercise evidence for modules not covered by required summary surfaces", async () => {
    const modules = Array.from({ length: 13 }, (_, index) => ({
      ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
      id: `remote-plugin-${index}`,
      name: `@remote/plugin-${index}`,
      actions: [
        {
          name: `REMOTE_ACTION_${index}`,
          description: `Run remote plugin ${index}.`,
        },
      ],
    }));
    installMinimalFixtureFetch(
      {
        "plugin.action.invoke":
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
      },
      { modules },
    );

    const report = await assertRemoteCapabilityEndpointConformance({
      endpoint: {
        id: "remote-endpoint",
        baseUrl: "https://remote.example.test",
      },
      requiredSurfaces: ["action"],
    });

    expect(report.exercised).toEqual({
      action: "remote-plugin-0:REMOTE_ACTION_0",
    });
    expect(report.moduleExercises).toEqual(
      modules.map((module, index) => ({
        surface: "action",
        moduleId: module.id,
        target: `${module.id}:REMOTE_ACTION_${index}`,
      })),
    );
    expect(report.rpcCalls).toEqual(
      modules.map((module, index) => ({
        method: "plugin.action.invoke",
        surface: "action",
        moduleId: module.id,
        target: `${module.id}:REMOTE_ACTION_${index}`,
      })),
    );
  });

  it("can backfill module exercise evidence through non-basic plugin surfaces", async () => {
    installMinimalFixtureFetch(
      {
        "plugin.action.invoke":
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
        "plugin.service.call":
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service,
      },
      {
        modules: [
          {
            id: "action-module",
            name: "@remote/action-module",
            actions: [
              {
                name: "ACTION_MODULE_RUN",
                description: "Run the action module.",
              },
            ],
          },
          {
            id: "service-only-module",
            name: "@remote/service-only-module",
            services: [
              {
                serviceType: "service-only",
                methods: ["ping"],
              },
            ],
          },
        ],
      },
    );

    const report = await assertRemoteCapabilityEndpointConformance({
      endpoint: {
        id: "remote-endpoint",
        baseUrl: "https://remote.example.test",
      },
      requiredSurfaces: ["action"],
    });

    expect(report.exercised).toEqual({
      action: "action-module:ACTION_MODULE_RUN",
    });
    expect(report.moduleExercises).toEqual([
      {
        surface: "action",
        moduleId: "action-module",
        target: "action-module:ACTION_MODULE_RUN",
      },
      {
        surface: "service",
        moduleId: "service-only-module",
        target: "service-only-module:service-only.ping",
      },
    ]);
    expect(report.rpcCalls).toEqual([
      {
        method: "plugin.action.invoke",
        surface: "action",
        moduleId: "action-module",
        target: "action-module:ACTION_MODULE_RUN",
      },
      {
        method: "plugin.service.call",
        surface: "service",
        moduleId: "service-only-module",
        target: "service-only-module:service-only.ping",
      },
    ]);
  });

  it("fails when remote route conformance returns a non-2xx status", async () => {
    installMinimalFixtureFetch({
      "plugin.route.call": {
        ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route,
        status: 500,
      },
    });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["route"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a non-2xx route status.',
    );
  });

  it("fails when remote route conformance does not return a body", async () => {
    installMinimalFixtureFetch({
      "plugin.route.call": {
        status: 204,
        headers: { "x-capability-fixture": "yes" },
      },
    });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["route"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned an empty route result.',
    );
  });

  it("fails when remote route conformance returns an empty body", async () => {
    installMinimalFixtureFetch({
      "plugin.route.call": {
        status: 200,
        headers: { "x-capability-fixture": "yes" },
        body: {},
      },
    });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["route"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned an empty route result.',
    );
  });

  it.each([
    [
      "plugin.action.invoke",
      "action",
      {},
      'Capability endpoint "remote-endpoint" returned an empty action result.',
    ],
    [
      "plugin.provider.get",
      "provider",
      {},
      'Capability endpoint "remote-endpoint" returned an empty provider result.',
    ],
    ["plugin.model.invoke", "model", {}, "result is required."],
    [
      "plugin.lifecycle.call",
      "lifecycle",
      { ok: false },
      'Capability endpoint "remote-endpoint" returned a failed lifecycle result.',
    ],
    [
      "plugin.event.handle",
      "event",
      { handled: false },
      'Capability endpoint "remote-endpoint" returned an unhandled event result.',
    ],
    [
      "plugin.service.call",
      "service",
      {},
      'Capability endpoint "remote-endpoint" returned an empty service result.',
    ],
    [
      "plugin.appBridge.call",
      "appBridge",
      {},
      'Capability endpoint "remote-endpoint" returned an empty app bridge result.',
    ],
  ] as const)("fails when %s returns weak conformance evidence", async (method, surface, result, message) => {
    installMinimalFixtureFetch({ [method]: result });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: [surface],
      }),
    ).rejects.toThrow(message);
  });

  it.each([
    [
      "plugin.evaluator.process",
      "evaluator",
      {},
      'Capability endpoint "remote-endpoint" returned an empty evaluator process result.',
    ],
    [
      "plugin.responseHandlerEvaluator.evaluate",
      "responseHandlerEvaluator",
      {},
      'Capability endpoint "remote-endpoint" returned an empty response-handler evaluator result.',
    ],
    [
      "plugin.responseHandlerFieldEvaluator.parse",
      "responseHandlerFieldEvaluator",
      {},
      'Capability endpoint "remote-endpoint" returned an empty response-handler field evaluator parse result.',
    ],
    [
      "plugin.responseHandlerFieldEvaluator.handle",
      "responseHandlerFieldEvaluator",
      {},
      'Capability endpoint "remote-endpoint" returned an empty response-handler field evaluator handle result.',
    ],
  ] as const)("fails when %s returns weak staged conformance evidence", async (method, surface, result, message) => {
    installMinimalFixtureFetch({ [method]: result });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: [surface],
      }),
    ).rejects.toThrow(message);
  });

  it("fails when remote view conformance returns a non-JavaScript asset", async () => {
    installMinimalFixtureFetch({
      "plugin.asset.get": {
        ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
        path: "/assets/fixture-view.css",
        contentType: "text/css",
      },
    });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["viewAsset"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a non-JavaScript view asset path.',
    );
  });

  it("fails when remote view asset content type does not match the manifest", async () => {
    installMinimalFixtureFetch({
      "plugin.asset.get": {
        ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
        contentType: "application/javascript",
      },
    });

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["viewAsset"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a view asset content type that does not match its manifest.',
    );
  });

  it("fails when remote view asset integrity does not match the manifest", async () => {
    installMinimalFixtureFetch(
      {
        "plugin.asset.get": {
          ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
          integrity: "sha256-other",
        },
      },
      {
        modules: [
          {
            ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
            views: [
              {
                ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.views[0],
                integrity: "sha256-manifest",
              },
            ],
          },
        ],
      },
    );

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["viewAsset"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a view asset integrity value that does not match its manifest.',
    );
  });

  it("fails when remote view asset integrity does not match the returned bytes", async () => {
    installMinimalFixtureFetch(
      {
        "plugin.asset.get": {
          ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
          integrity: "sha256-deadbeef",
        },
      },
      {
        modules: [
          {
            ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
            views: [
              {
                ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.views[0],
                integrity: "sha256-deadbeef",
              },
            ],
          },
        ],
      },
    );

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["viewAsset"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a view asset integrity value that does not match its bytes.',
    );
  });

  it("fails when remote view asset integrity lacks a sha256 token", async () => {
    const assetBytes = Buffer.from(
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.bodyBase64,
      "base64",
    );
    const integrity = `sha384-${createHash("sha384").update(assetBytes).digest("base64")}`;
    installMinimalFixtureFetch(
      {
        "plugin.asset.get": {
          ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
          integrity,
        },
      },
      {
        modules: [
          {
            ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
            views: [
              {
                ...CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.views[0],
                integrity,
              },
            ],
          },
        ],
      },
    );

    await expect(
      assertRemoteCapabilityEndpointConformance({
        endpoint: {
          id: "remote-endpoint",
          baseUrl: "https://remote.example.test",
        },
        requiredSurfaces: ["viewAsset"],
      }),
    ).rejects.toThrow(
      'Capability endpoint "remote-endpoint" returned a view asset integrity value without a sha256 digest.',
    );
  });
});

function installMinimalFixtureFetch(
  resultsByMethod: Record<string, unknown>,
  options: {
    modules?: unknown[];
  } = {},
): void {
  const results: Record<string, unknown> = {
    "plugin.action.invoke": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action,
    "plugin.provider.get": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider,
    "plugin.route.call": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route,
    "plugin.asset.get": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
    "plugin.model.invoke": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model,
    "plugin.lifecycle.call":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle,
    "plugin.event.handle": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event,
    "plugin.service.call": CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service,
    "plugin.appBridge.call":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge,
    "plugin.evaluator.shouldRun":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun,
    "plugin.evaluator.prepare":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare,
    "plugin.evaluator.prompt":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt,
    "plugin.evaluator.process":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess,
    "plugin.responseHandlerEvaluator.shouldRun":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerEvaluatorShouldRun,
    "plugin.responseHandlerEvaluator.evaluate":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerEvaluatorEvaluate,
    "plugin.responseHandlerFieldEvaluator.shouldRun":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorShouldRun,
    "plugin.responseHandlerFieldEvaluator.parse":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorParse,
    "plugin.responseHandlerFieldEvaluator.handle":
      CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
        .responseHandlerFieldEvaluatorHandle,
    ...resultsByMethod,
  };
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { method?: string })
      : undefined;
    if (String(url) === "https://remote.example.test/v1/capabilities") {
      return jsonResponse({
        environment: "server",
        available: true,
        capabilities: {
          fs: false,
          pty: false,
          git: false,
          model: false,
          plugin: true,
        },
      });
    }
    if (body?.method === "plugin.modules.list") {
      return jsonResponse({
        ok: true,
        result: {
          modules: options.modules ?? [
            CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module,
          ],
        },
      });
    }
    if (body?.method && body.method in results) {
      return jsonResponse({ ok: true, result: results[body.method] });
    }
    return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
