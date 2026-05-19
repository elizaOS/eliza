import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IAgentRuntime, Plugin, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  summarizeRemoteCapabilityEndpointUrlFingerprint,
  summarizeRemoteCapabilityLiveRuntime,
  summarizeRemoteCapabilityLiveSync,
  writeRemoteCapabilityLiveReport,
} from "./remote-capability-live-report.ts";

describe("remote capability live report summaries", () => {
  it("summarizes every materialized remote plugin surface used by the live validator", () => {
    const plugin = makeSurfacePlugin();
    const sync = summarizeRemoteCapabilityLiveSync({
      registered: [plugin],
      unloaded: [],
      skipped: [],
      trustDecisions: [
        {
          moduleId: "surface-module",
          pluginName: "@remote/surface",
          endpointId: "surface-endpoint",
          trusted: true,
          reason: "allowed",
        },
      ],
    });
    const runtime = summarizeRemoteCapabilityLiveRuntime({
      agentId: "55555555-5555-5555-5555-555555555555" as UUID,
      character: { name: "Live Report Summary Test" },
      plugins: [plugin],
      actions: plugin.actions ?? [],
      providers: plugin.providers ?? [],
      evaluators: plugin.evaluators ?? [],
      routes: plugin.routes ?? [],
    } as IAgentRuntime & {
      actions: NonNullable<Plugin["actions"]>;
      providers: NonNullable<Plugin["providers"]>;
      evaluators: NonNullable<Plugin["evaluators"]>;
      routes: NonNullable<Plugin["routes"]>;
    });

    expect(sync).toMatchObject({
      registered: ["@remote/surface"],
      registeredModules: [
        {
          pluginName: "@remote/surface",
          moduleId: "surface-module",
          endpointId: "surface-endpoint",
          actionCount: 1,
          providerCount: 1,
          evaluatorCount: 1,
          responseHandlerEvaluatorCount: 1,
          responseHandlerFieldEvaluatorCount: 1,
          routeCount: 1,
          modelCount: 1,
          eventCount: 2,
          serviceCount: 1,
          appCount: 1,
          appBridgeCount: 1,
          lifecycleCount: 3,
          widgetCount: 1,
          componentTypeCount: 1,
          viewCount: 1,
        },
      ],
    });
    expect(runtime).toMatchObject({
      pluginCount: 1,
      remotePlugins: [
        {
          pluginName: "@remote/surface",
          moduleId: "surface-module",
          endpointId: "surface-endpoint",
        },
      ],
      actionCount: 1,
      providerCount: 1,
      evaluatorCount: 1,
      responseHandlerEvaluatorCount: 1,
      responseHandlerFieldEvaluatorCount: 1,
      routeCount: 1,
      modelCount: 1,
      eventCount: 2,
      serviceCount: 1,
      appCount: 1,
      appBridgeCount: 1,
      lifecycleCount: 3,
      widgetCount: 1,
      componentTypeCount: 1,
      viewCount: 1,
    });
  });

  it("summarizes endpoint URL identity without writing the URL into live artifacts", () => {
    expect(
      summarizeRemoteCapabilityEndpointUrlFingerprint(
        "https://provider.example.test/capability/?token=secret#debug",
      ),
    ).toBe(
      summarizeRemoteCapabilityEndpointUrlFingerprint(
        "https://provider.example.test/capability",
      ),
    );
  });

  it("rejects credential-bearing endpoint URLs before fingerprinting", () => {
    expect(() =>
      summarizeRemoteCapabilityEndpointUrlFingerprint(
        "https://user:password@provider.example.test/capability",
      ),
    ).toThrow("must not include embedded credentials");
  });

  it("writes live report artifacts once with safe names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-capability-live-report-"));
    const previousDir = process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR;
    process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR = dir;
    try {
      await writeRemoteCapabilityLiveReport("home-machine", {
        kind: "provider",
        provider: "home-machine",
      });
      await expect(
        readFile(join(dir, "home-machine.json"), "utf8"),
      ).resolves.toContain('"kind": "provider"');
      await expect(
        writeRemoteCapabilityLiveReport("home-machine", {
          kind: "provider",
          provider: "home-machine",
        }),
      ).rejects.toThrow();
      await expect(
        writeRemoteCapabilityLiveReport("../home-machine", {
          kind: "provider",
        }),
      ).rejects.toThrow("must use lowercase letters");
      await expect(
        writeRemoteCapabilityLiveReport("e2b", {
          kind: "provider",
          provider: "home-machine",
        }),
      ).rejects.toThrow("must match provider");
      await expect(
        writeRemoteCapabilityLiveReport("cloud-live", {
          kind: "cloud",
        }),
      ).rejects.toThrow('must be "cloud"');
      await expect(
        writeRemoteCapabilityLiveReport("e2b", {
          kind: "other",
        }),
      ).rejects.toThrow('kind must be either "cloud" or "provider"');
    } finally {
      if (previousDir === undefined) {
        delete process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR;
      } else {
        process.env.ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR = previousDir;
      }
      await rm(dir, { force: true, recursive: true });
    }
  });
});

function makeSurfacePlugin(): Plugin {
  return {
    name: "@remote/surface",
    description: "Surface plugin.",
    actions: [
      {
        name: "SURFACE_ACTION",
        description: "Surface action.",
        validate: async () => true,
        handler: async () => ({ success: true }),
      },
    ] as NonNullable<Plugin["actions"]>,
    providers: [
      {
        name: "SURFACE_CONTEXT",
        get: async () => ({ text: "surface" }),
      },
    ],
    evaluators: [
      {
        name: "SURFACE_EVALUATOR",
        description: "Surface evaluator.",
        similes: [],
      },
    ] as unknown as NonNullable<Plugin["evaluators"]>,
    responseHandlerEvaluators: [
      {
        name: "SURFACE_RESPONSE_EVALUATOR",
        shouldRun: async () => true,
        evaluate: async () => ({}),
      },
    ],
    responseHandlerFieldEvaluators: [
      {
        name: "SURFACE_FIELD_EVALUATOR",
        description: "Surface field evaluator.",
        schema: { type: "object" },
        shouldRun: async () => true,
      },
    ] as NonNullable<Plugin["responseHandlerFieldEvaluators"]>,
    routes: [{ type: "GET", path: "/surface" }],
    models: {
      TEXT_SMALL: async () => ({ text: "surface" }) as never,
    },
    events: {
      "surface.event": [async () => undefined, async () => undefined],
    } as NonNullable<Plugin["events"]>,
    services: [{} as NonNullable<Plugin["services"]>[number]],
    app: {
      displayName: "Surface App",
      category: "tool",
    },
    appBridge: {},
    init: async () => undefined,
    dispose: async () => undefined,
    applyConfig: async () => undefined,
    widgets: [
      {
        id: "surface.widget",
        pluginId: "@remote/surface",
        slot: "chat-sidebar",
        label: "Surface Widget",
      },
    ],
    componentTypes: [
      {
        name: "surface.component",
        schema: { type: "object" },
      },
    ],
    views: [
      {
        id: "surface.view",
        label: "Surface View",
      },
    ],
    config: {
      remoteCapabilityModuleId: "surface-module",
      remoteCapabilityEndpointId: "surface-endpoint",
    },
  };
}
