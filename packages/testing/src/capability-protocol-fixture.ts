/** Deterministic capability protocol payloads for tests and fixture servers. */
import type {
  CapabilityAvailability,
  PluginCallAppBridgeResult,
  PluginCallRouteResult,
  PluginCallServiceResult,
  PluginEvaluatorPrepareResult,
  PluginEvaluatorProcessResult,
  PluginEvaluatorPromptResult,
  PluginEvaluatorShouldRunResult,
  PluginGetAssetResult,
  PluginGetProviderResult,
  PluginHandleEventResult,
  PluginInvokeActionResult,
  PluginInvokeModelResult,
  PluginLifecycleCallResult,
  PluginResponseHandlerEvaluatorEvaluateResult,
  PluginResponseHandlerEvaluatorShouldRunResult,
  PluginResponseHandlerFieldEvaluatorHandleResult,
  PluginResponseHandlerFieldEvaluatorParseResult,
  PluginResponseHandlerFieldEvaluatorShouldRunResult,
  RemotePluginModuleManifest,
} from "@elizaos/core";

export const CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION = "2026-05-19" as const;

export const CAPABILITY_ROUTER_PROTOCOL_FIXTURE = {
  availability: {
    environment: "server",
    available: true,
    capabilities: {
      fs: false,
      pty: false,
      git: false,
      model: false,
      plugin: true,
    },
  },
  module: {
    id: "fixture-remote-plugin",
    name: "@remote/fixture-plugin",
    version: "1.0.0",
    description: "Canonical capability-router remote plugin fixture.",
    priority: 25,
    contexts: ["developer", "remote-fixture"],
    config: { fixtureMode: true },
    schema: {
      remote_fixture_records: {
        id: "uuid",
        label: "text",
      },
    },
    actions: [
      {
        name: "FIXTURE_ACTION",
        description: "Exercise a remote action through the protocol.",
      },
    ],
    providers: [
      {
        name: "FIXTURE_CONTEXT",
        description: "Exercise a remote provider through the protocol.",
      },
    ],
    evaluators: [
      {
        name: "FIXTURE_EVALUATOR",
        description: "Exercise a remote evaluator through the protocol.",
        prompt: "Evaluate the fixture response.",
        schema: { type: "object" },
        hasPrepare: true,
        hasProcessor: true,
      },
    ],
    responseHandlerEvaluators: [
      {
        name: "FIXTURE_RESPONSE_EVALUATOR",
        description: "Exercise a response-handler evaluator.",
      },
    ],
    responseHandlerFieldEvaluators: [
      {
        name: "FIXTURE_FIELD_EVALUATOR",
        description: "Exercise a response-handler field evaluator.",
        schema: { type: "object" },
        hasParse: true,
        hasHandle: true,
      },
    ],
    events: [{ eventName: "fixture.event" }],
    models: [{ modelType: "TEXT_SMALL", priority: 1 }],
    services: [
      {
        serviceType: "fixture-service",
        capabilityDescription: "Fixture remote service.",
        methods: ["ping"],
        config: { fixture: true },
      },
    ],
    componentTypes: [
      {
        name: "fixture.component",
        schema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Fixture label." },
            count: { type: "number" },
          },
          required: ["label"],
        },
      },
    ],
    widgets: [
      {
        id: "fixture-widget",
        slot: "chat-sidebar",
        label: "Fixture Widget",
        componentExport: "FixtureWidget",
      },
    ],
    app: {
      displayName: "Fixture Remote App",
      category: "developer",
      launchType: "remote",
      launchUrl: "https://fixture.example.test/app",
      viewer: {
        url: "https://fixture.example.test/viewer",
        postMessageAuth: true,
      },
      session: {
        mode: "spectate-and-steer",
        features: ["commands", "telemetry"],
      },
      navTabs: [
        {
          id: "fixture-tab",
          label: "Fixture",
          path: "/apps/fixture",
          componentExport: "FixtureTab",
        },
      ],
    },
    appBridge: {
      hooks: ["prepareLaunch", "handleAppRoutes"],
    },
    lifecycle: {
      hooks: ["init", "dispose", "applyConfig"],
    },
    routes: [
      {
        method: "POST",
        path: "/fixture/route",
        public: true,
        name: "fixture-route",
        publicReason:
          "Capability-router fixture route is unauthenticated test transport.",
      },
    ],
    views: [
      {
        id: "fixture.view",
        label: "Fixture View",
        viewType: "gui",
        bundlePath: "/assets/fixture-view.js",
        contentType: "text/javascript",
      },
    ],
    provenance: {
      issuer: "fixture-build",
      subject: "fixture://remote-plugin",
      digestSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      signatureAlgorithm: "ed25519",
      signature: "fixture-signature",
    },
    metadata: {
      fixtureVersion: CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION,
    },
  },
  results: {
    action: {
      text: "fixture action",
      data: { fixture: true },
    },
    provider: {
      text: "fixture provider",
      values: { fixture: true },
    },
    route: {
      status: 209,
      headers: { "x-capability-fixture": "yes" },
      body: { fixtureRoute: true },
    },
    asset: {
      path: "/assets/fixture-view.js",
      contentType: "text/javascript",
      bodyBase64: "ZXhwb3J0IGNvbnN0IGZpeHR1cmVWaWV3ID0gdHJ1ZTsK",
    },
    model: {
      result: { text: "fixture model", fixture: true },
    },
    lifecycle: {
      ok: true,
    },
    event: {
      handled: true,
    },
    service: {
      result: { text: "fixture service", fixture: true },
    },
    appBridge: {
      result: {
        handled: true,
        status: 208,
        headers: { "x-capability-fixture-bridge": "yes" },
        body: { fixtureAppBridge: true },
      },
    },
    evaluatorShouldRun: {
      shouldRun: true,
    },
    evaluatorPrepare: {
      prepared: { fixturePrepared: true },
    },
    evaluatorPrompt: {
      prompt: "fixture evaluator prompt",
    },
    evaluatorProcess: {
      result: { fixtureProcessed: true },
    },
    responseHandlerEvaluatorShouldRun: {
      shouldRun: true,
    },
    responseHandlerEvaluatorEvaluate: {
      patch: { fixtureResponsePatch: true },
    },
    responseHandlerFieldEvaluatorShouldRun: {
      shouldRun: true,
    },
    responseHandlerFieldEvaluatorParse: {
      value: { fixtureParsed: true },
    },
    responseHandlerFieldEvaluatorHandle: {
      effect: {
        patch: { fixtureHandled: true },
        debug: ["fixture field handled"],
      },
    },
  },
} as const satisfies {
  availability: CapabilityAvailability;
  module: RemotePluginModuleManifest;
  results: {
    action: PluginInvokeActionResult;
    provider: PluginGetProviderResult;
    route: PluginCallRouteResult;
    asset: PluginGetAssetResult;
    model: PluginInvokeModelResult;
    lifecycle: PluginLifecycleCallResult;
    event: PluginHandleEventResult;
    service: PluginCallServiceResult;
    appBridge: PluginCallAppBridgeResult;
    evaluatorShouldRun: PluginEvaluatorShouldRunResult;
    evaluatorPrepare: PluginEvaluatorPrepareResult;
    evaluatorPrompt: PluginEvaluatorPromptResult;
    evaluatorProcess: PluginEvaluatorProcessResult;
    responseHandlerEvaluatorShouldRun: PluginResponseHandlerEvaluatorShouldRunResult;
    responseHandlerEvaluatorEvaluate: PluginResponseHandlerEvaluatorEvaluateResult;
    responseHandlerFieldEvaluatorShouldRun: PluginResponseHandlerFieldEvaluatorShouldRunResult;
    responseHandlerFieldEvaluatorParse: PluginResponseHandlerFieldEvaluatorParseResult;
    responseHandlerFieldEvaluatorHandle: PluginResponseHandlerFieldEvaluatorHandleResult;
  };
};
