/**
 * Tests for the `capability-router` CLI helpers: `buildCapabilityRouterConnectPayload`
 * (shaping and validating direct/provider/cloud connect payloads) and
 * `runCapabilityRouterConformance` (driving a remote endpoint through every
 * plugin-protocol surface). Uses the shared `CAPABILITY_ROUTER_PROTOCOL_FIXTURE`
 * and a mocked `fetch` to assert payload shape, method call ordering, and bearer
 * auth without a live endpoint.
 */
import { CAPABILITY_ROUTER_PROTOCOL_FIXTURE } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCapabilityRouterConnectPayload,
  runCapabilityRouterConformance,
} from "./register.capability-router";

const originalFetch = globalThis.fetch;

describe("buildCapabilityRouterConnectPayload", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds a direct endpoint payload without provider noise", () => {
    expect(
      buildCapabilityRouterConnectPayload("https://device.example.test/", {
        provider: "direct",
        id: "device",
        token: "secret",
        allowedModule: ["device-plugin", "device-plugin", " "],
        persist: false,
        requestTimeoutMs: "9000",
      }),
    ).toEqual({
      endpoint: {
        baseUrl: "https://device.example.test/",
        id: "device",
        token: "secret",
      },
      allowedModuleIds: ["device-plugin"],
      requestTimeoutMs: 9000,
      persist: false,
    });
  });

  it("builds a URL-backed provider payload", () => {
    expect(
      buildCapabilityRouterConnectPayload("https://home.example.test", {
        provider: "home-machine",
        id: "home",
        allowedModule: ["home-plugin"],
      }),
    ).toEqual({
      provider: "home-machine",
      endpoint: {
        baseUrl: "https://home.example.test",
        id: "home",
      },
      allowedModuleIds: ["home-plugin"],
    });
  });

  it("builds a Cloud provisioning payload", () => {
    expect(
      buildCapabilityRouterConnectPayload(undefined, {
        cloud: true,
        cloudApiBase: "https://api.elizacloud.ai",
        cloudAuthToken: "cloud-secret",
        cloudName: "Remote Tools",
        cloudBio: ["Runs remote plugin modules"],
        cloudEndpointId: "cloud-tools",
        cloudTimeoutMs: "120000",
        cloudPollIntervalMs: "2000",
        allowedModule: ["cloud-plugin"],
      }),
    ).toEqual({
      allowedModuleIds: ["cloud-plugin"],
      cloud: {
        cloudApiBase: "https://api.elizacloud.ai",
        authToken: "cloud-secret",
        name: "Remote Tools",
        bio: ["Runs remote plugin modules"],
        endpointId: "cloud-tools",
        timeoutMs: 120000,
        pollIntervalMs: 2000,
      },
    });
  });

  it("rejects unknown provider modes", () => {
    expect(() =>
      buildCapabilityRouterConnectPayload(
        "https://unknown-provider.example.test",
        {
          provider: "unknown-provider" as never,
        },
      ),
    ).toThrow(
      "provider must be one of direct, e2b, home-machine, mobile-companion, or desktop-companion.",
    );
  });

  it("validates an endpoint against the capability-router conformance protocol", async () => {
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string })
        : undefined;
      calls.push({
        url: String(url),
        method: body?.method,
        auth:
          init?.headers && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>).authorization
            : undefined,
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
      if (body?.method === "plugin.modules.list") {
        return jsonResponse({
          ok: true,
          result: {
            modules: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module],
          },
        });
      }
      if (body?.method === "plugin.route.call") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route,
        });
      }
      if (body?.method === "plugin.asset.get") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset,
        });
      }
      if (body?.method === "plugin.model.invoke") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model,
        });
      }
      if (body?.method === "plugin.lifecycle.call") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle,
        });
      }
      if (body?.method === "plugin.event.handle") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event,
        });
      }
      if (body?.method === "plugin.service.call") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service,
        });
      }
      if (body?.method === "plugin.appBridge.call") {
        return jsonResponse({
          ok: true,
          result: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge,
        });
      }
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
        return jsonResponse({ ok: true, result: resultByMethod[body.method] });
      }
      return jsonResponse({ ok: true, result: { text: "ok" } });
    }) as unknown as typeof fetch;

    await expect(
      runCapabilityRouterConformance("https://remote.example.test/", {
        token: "secret",
        requestTimeoutMs: "5000",
      }),
    ).resolves.toEqual({
      baseUrl: "https://remote.example.test",
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
      routeStatus: 209,
      asset: {
        path: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.path,
        contentType: "text/javascript",
        byteLength: Buffer.from(
          CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset.bodyBase64,
          "base64",
        ).byteLength,
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
    expect(calls.every((call) => call.auth === "Bearer secret")).toBe(true);
  });

  it("rejects conformance checks with unknown required surfaces", async () => {
    await expect(
      runCapabilityRouterConformance("https://remote.example.test", {
        require: ["unknown-surface"],
      }),
    ).rejects.toThrow(
      "require must be one of action, provider, route, view-asset, model, lifecycle, event, service, app-bridge, evaluator, response-handler-evaluator, or response-handler-field-evaluator.",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
