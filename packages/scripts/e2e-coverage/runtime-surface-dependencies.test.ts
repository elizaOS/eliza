/**
 * Verifies explicit synthetic-world service and mock ownership independently
 * from package-manager imports. The fixture is deterministic and never loads a
 * provider client, starts a server, or contacts an external service.
 */

import { describe, expect, test } from "bun:test";
import {
  loadRuntimeDependencyCatalog,
  parseMockoonHttpOperations,
  RUNTIME_DEPENDENCY_SCHEMA,
  type RuntimeDependencyCatalog,
  resolveRuntimeDependencies,
  validateRuntimeDependencyCatalog,
} from "./runtime-surface-inventory.ts";

function mockoonFixture() {
  return {
    endpointPrefix: "/api/",
    folders: [],
    routes: [
      {
        uuid: "route-1",
        type: "http",
        method: "post",
        endpoint: "/v1/example",
        responses: [
          {
            uuid: "response-1",
            statusCode: 200,
            default: true,
            bodyType: "INLINE",
            body: "{}",
          },
        ],
      },
    ],
    rootChildren: [{ type: "route", uuid: "route-1" }],
  };
}

function catalog(
  rules: RuntimeDependencyCatalog["rules"],
): RuntimeDependencyCatalog {
  return {
    schema: RUNTIME_DEPENDENCY_SCHEMA,
    upstreamCatalog: {
      pullRequest: 23185,
      head: "0f14c26c6ae4b28771d984c32e8d1fd79c7929ee",
      path: "packages/cloud/test-mocks/provider-mock-catalog.json",
      relationship:
        "Fixture relationship is explicit and long enough to remain reviewable.",
    },
    rules,
    localPackages: {},
  };
}

describe("runtime surface dependency catalog", () => {
  test("fails unmatched surfaces closed instead of inferring a local boundary", () => {
    const resolved = resolveRuntimeDependencies("@elizaos/agent", "provider");
    expect(resolved).toEqual({
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "unresolved",
    });
  });

  test("binds an external model protocol to a concrete mock owner and source", () => {
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-openai",
        "model-handler",
        undefined,
        "@elizaos/plugin-openai:model-handler:text_small",
      ),
    ).toEqual({
      externalServiceDependencies: [
        { id: "openai-api", protocol: "OpenAI API v1" },
      ],
      mockDependencies: [
        {
          serviceId: "openai-api",
          availability: "available",
          owner: "openai",
          source:
            "packages/scenario-runner/test/mocks/environments/openai.json",
          reason:
            "openai owns the OpenAI API v1 mock source at packages/scenario-runner/test/mocks/environments/openai.json; row-level reset proof remains separate.",
        },
      ],
      dependencyDisposition: "mock-owned",
    });
  });

  test("records a known connector gap without fabricating a mock owner", () => {
    const resolved = resolveRuntimeDependencies(
      "@elizaos/plugin-instagram",
      "connector-egress",
    );
    expect(resolved.dependencyDisposition).toBe("mock-missing");
    expect(resolved.externalServiceDependencies).toEqual([
      {
        id: "instagram-graph-api",
        protocol: "Meta Instagram Graph API and webhooks",
      },
    ]);
    expect(resolved.mockDependencies).toEqual([
      expect.objectContaining({
        serviceId: "instagram-graph-api",
        availability: "missing",
        owner: null,
        source: null,
      }),
    ]);
  });

  test("fails closed for absent and duplicate package-kind ownership", () => {
    const localRule = {
      packageName: "@elizaos/example",
      kinds: ["provider" as const],
      noExternalServiceReason:
        "The example provider reads only deterministic runtime-local fixture state.",
    };
    expect(
      resolveRuntimeDependencies(
        "@elizaos/missing",
        "route",
        catalog([]),
        "@elizaos/missing:route:/new-external",
        "plugins/missing/src/routes/new-external.ts",
      ).dependencyDisposition,
    ).toBe("unresolved");
    expect(() =>
      validateRuntimeDependencyCatalog(
        [{ packageName: "@elizaos/example", kind: "provider" }],
        catalog([localRule, localRule]),
      ),
    ).toThrow(/duplicate=/);
  });

  test("requires an explicit disposition for actions, services, and workers", () => {
    const allKindsRule = {
      packageName: "@elizaos/example",
      kinds: [
        "action" as const,
        "service" as const,
        "scheduled-worker" as const,
      ],
      noExternalServiceReason:
        "The example package uses only deterministic local production boundaries.",
    };
    expect(() =>
      validateRuntimeDependencyCatalog(
        [
          { packageName: "@elizaos/example", kind: "action" },
          { packageName: "@elizaos/example", kind: "service" },
          { packageName: "@elizaos/example", kind: "scheduled-worker" },
        ],
        catalog([allKindsRule]),
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeDependencyCatalog(
        [{ packageName: "@elizaos/missing", kind: "service" }],
        catalog([]),
      ),
    ).not.toThrow();
  });

  test("rejects empty, duplicate, and non-canonical selectors", () => {
    const reason =
      "The exact fixture surface reads only deterministic runtime-local state.";
    for (const rule of [
      {
        packageName: "@elizaos/example",
        kinds: [] as never[],
        noExternalServiceReason: reason,
      },
      {
        packageName: "@elizaos/example",
        kinds: ["provider" as const, "provider" as const],
        noExternalServiceReason: reason,
      },
      {
        packageName: "@elizaos/example",
        kinds: ["provider" as const],
        sourcePathPrefixes: ["../outside"],
        noExternalServiceReason: reason,
      },
    ]) {
      expect(() =>
        validateRuntimeDependencyCatalog(
          [{ packageName: "@elizaos/example", kind: "provider" }],
          catalog([rule]),
        ),
      ).toThrow(/unique explicit kinds|non-canonical sourcePathPrefixes/);
    }
  });

  test("attributes selected implementations without package-wide dependency fiction", () => {
    for (const [kind, surfaceId] of [
      ["action", "@elizaos/plugin-calendar:action:calendar"],
      ["service", "@elizaos/plugin-calendar:service:calendar"],
    ] as const) {
      const resolved = resolveRuntimeDependencies(
        "@elizaos/plugin-calendar",
        kind,
        undefined,
        surfaceId,
      );
      expect(resolved.dependencyDisposition).toBe("mock-missing");
      expect(
        resolved.externalServiceDependencies.map((entry) => entry.id),
      ).toEqual([
        "google-calendar-api",
        "microsoft-graph-calendar",
        "apple-eventkit-calendar",
        "ics-feed-http",
      ]);
    }
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-calendar",
        "route",
        undefined,
        "@elizaos/plugin-calendar:route:/api/lifeops/calendar/google/webhook",
      ).externalServiceDependencies.map((entry) => entry.id),
    ).toEqual(["google-calendar-api"]);
    for (const [kind, surfaceId] of [
      ["provider", "@elizaos/plugin-calendar:provider:calendarsources"],
      ["service", "@elizaos/plugin-calendar:service:calendar_migration"],
      ["view", "@elizaos/plugin-calendar:view:calendar"],
    ] as const) {
      expect(
        resolveRuntimeDependencies(
          "@elizaos/plugin-calendar",
          kind,
          undefined,
          surfaceId,
        ),
      ).toEqual({
        dependencyDisposition: "local-only",
        externalServiceDependencies: [],
        mockDependencies: [],
      });
    }
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-calendar",
        "action",
        undefined,
        "@elizaos/plugin-calendar:action:new_unreviewed_action",
      ).dependencyDisposition,
    ).toBe("unresolved");
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-vision",
        "service",
        undefined,
        "@elizaos/plugin-vision:service:vision-ocr-bridge",
      ),
    ).toEqual({
      dependencyDisposition: "local-only",
      externalServiceDependencies: [],
      mockDependencies: [],
    });
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-browser",
        "action",
        undefined,
        "@elizaos/plugin-browser:action:manage_browser_bridge",
        "plugins/plugin-browser/src/actions/manage-browser-bridge.ts",
      ).dependencyDisposition,
    ).toBe("unresolved");
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-discord",
        "service",
        undefined,
        "@elizaos/plugin-discord:service:discord_user_account_scraper",
        "plugins/plugin-discord/user-account-scraper/service.ts",
      ).externalServiceDependencies.map((entry) => entry.id),
    ).toEqual(["browser-automation"]);
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-vision",
        "service",
        undefined,
        "@elizaos/plugin-vision:service:vision",
      ),
    ).toEqual({
      dependencyDisposition: "unresolved",
      externalServiceDependencies: [],
      mockDependencies: [],
    });
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-wallet",
        "service",
        undefined,
        "@elizaos/plugin-wallet:service:news_data_service",
      ),
    ).toEqual({
      dependencyDisposition: "unresolved",
      externalServiceDependencies: [],
      mockDependencies: [],
    });
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-wallet",
        "service",
        undefined,
        "@elizaos/plugin-wallet:service:userlpprofileservice",
      ),
    ).toEqual({
      dependencyDisposition: "local-only",
      externalServiceDependencies: [],
      mockDependencies: [],
    });
    expect(
      resolveRuntimeDependencies("@elizaos/cloud-api", "scheduled-worker"),
    ).toEqual({
      dependencyDisposition: "unresolved",
      externalServiceDependencies: [],
      mockDependencies: [],
    });
    const stripe = resolveRuntimeDependencies(
      "@elizaos/cloud-api",
      "route",
      undefined,
      "@elizaos/cloud-api:route:post-/api/stripe/create-checkout-session",
      "packages/cloud/api/stripe/create-checkout-session/route.ts",
    );
    expect(stripe.externalServiceDependencies.map((entry) => entry.id)).toEqual(
      ["postgresql", "stripe-api"],
    );
    const v1StripeWebhook = resolveRuntimeDependencies(
      "@elizaos/cloud-api",
      "route",
      undefined,
      "@elizaos/cloud-api:route:post-/api/v1/stripe/webhook",
      "packages/cloud/api/v1/stripe/webhook/route.ts",
    );
    expect(
      v1StripeWebhook.externalServiceDependencies.map((entry) => entry.id),
    ).toEqual(["postgresql", "stripe-api"]);
    expect(stripe.mockDependencies).toContainEqual(
      expect.objectContaining({
        serviceId: "stripe-api",
        availability: "missing",
      }),
    );
    expect(
      resolveRuntimeDependencies("@elizaos/plugin-goals", "service"),
    ).toEqual({
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "unresolved",
    });
  });

  test("rejects a claimed mock whose source does not exist", () => {
    const invalid = catalog([
      {
        packageName: "@elizaos/example",
        kinds: ["connector-ingress"],
        surfaceIds: ["@elizaos/example:connector-ingress:example"],
        externalServices: [
          {
            id: "example-api",
            protocol: "Example HTTP API",
            mockOwner: "example",
            mockSource: "packages/does-not-exist/mock.json",
            mockContract: {
              kind: "mockoon-http" as const,
              operations: [{ method: "POST", path: "v1/example" }],
            },
          },
        ],
      },
    ]);
    expect(() =>
      validateRuntimeDependencyCatalog(
        [
          {
            packageName: "@elizaos/example",
            kind: "connector-ingress",
            id: "@elizaos/example:connector-ingress:example",
          },
        ],
        invalid,
      ),
    ).toThrow(/mockSource is missing/);
  });

  test("rejects file-existence-only mock ownership for the wrong protocol", () => {
    const invalid = catalog([
      {
        packageName: "@elizaos/example",
        kinds: ["route"],
        surfaceIds: ["@elizaos/example:route:/example"],
        externalServices: [
          {
            id: "stripe-api",
            protocol: "Stripe checkout API",
            mockOwner: "internal-payments",
            mockSource:
              "packages/scenario-runner/test/mocks/environments/openai.json",
            mockContract: {
              kind: "mockoon-http" as const,
              operations: [{ method: "POST", path: "v1/checkout/sessions" }],
            },
          },
        ],
      },
    ]);
    expect(() =>
      validateRuntimeDependencyCatalog(
        [
          {
            packageName: "@elizaos/example",
            kind: "route",
            id: "@elizaos/example:route:/example",
          },
        ],
        invalid,
      ),
    ).toThrow(/does not register HTTP operation POST v1\/checkout\/sessions/);
  });

  test("requires exact surface ids for mock ownership", () => {
    const invalid = catalog([
      {
        packageName: "@elizaos/example",
        kinds: ["service"],
        externalServices: [
          {
            id: "example-api",
            protocol: "Example HTTP API",
            mockOwner: "example",
            mockSource:
              "packages/scenario-runner/test/mocks/environments/openai.json",
            mockContract: {
              kind: "mockoon-http" as const,
              operations: [{ method: "POST", path: "v1/chat/completions" }],
            },
          },
        ],
      },
    ]);
    expect(() =>
      validateRuntimeDependencyCatalog(
        [{ packageName: "@elizaos/example", kind: "service" }],
        invalid,
      ),
    ).toThrow(/mock ownership requires exact surfaceIds/);
  });

  test("parses registered prefix-aware Mockoon operations", () => {
    expect([
      ...parseMockoonHttpOperations(mockoonFixture(), "example-api"),
    ]).toEqual(["POST api/v1/example"]);
  });

  test("rejects malformed Mockoon responses", () => {
    for (const responses of [
      [],
      [null],
      [{}],
      [
        {
          uuid: "response-1",
          statusCode: 99,
          default: true,
          bodyType: "INLINE",
          body: "{}",
        },
      ],
      [
        {
          uuid: "response-1",
          statusCode: 200,
          default: true,
          bodyType: "INLINE",
          body: "{}",
        },
        {
          uuid: "response-2",
          statusCode: 500,
          default: true,
          bodyType: "INLINE",
          body: "{}",
        },
      ],
      [
        {
          uuid: "response-1",
          statusCode: 200,
          default: false,
          bodyType: "INLINE",
          body: "{}",
        },
      ],
    ]) {
      const fixture = mockoonFixture();
      fixture.routes[0].responses =
        responses as (typeof fixture.routes)[0]["responses"];
      expect(() => parseMockoonHttpOperations(fixture, "example-api")).toThrow(
        /unserved Mockoon HTTP route/,
      );
    }
  });

  test("accepts an empty inline body for a registered 204 response", () => {
    const fixture = mockoonFixture();
    fixture.routes[0].method = "DELETE";
    fixture.routes[0].responses[0].statusCode = 204;
    fixture.routes[0].responses[0].body = "";
    expect([...parseMockoonHttpOperations(fixture, "example-api")]).toEqual([
      "DELETE api/v1/example",
    ]);
  });

  test("rejects bad methods, orphan routes, unknown registrations, and duplicate operations", () => {
    const badMethod = mockoonFixture();
    badMethod.routes[0].method = "FAKE";
    expect(() => parseMockoonHttpOperations(badMethod, "example-api")).toThrow(
      /unserved Mockoon HTTP route/,
    );

    const orphan = mockoonFixture();
    orphan.rootChildren = [];
    expect(() => parseMockoonHttpOperations(orphan, "example-api")).toThrow(
      /unserved Mockoon HTTP route/,
    );

    const unknown = mockoonFixture();
    unknown.rootChildren[0].uuid = "missing-route";
    expect(() => parseMockoonHttpOperations(unknown, "example-api")).toThrow(
      /unserved Mockoon HTTP route/,
    );

    const duplicate = mockoonFixture();
    duplicate.routes.push({
      ...structuredClone(duplicate.routes[0]),
      uuid: "route-2",
    });
    duplicate.rootChildren.push({ type: "route", uuid: "route-2" });
    expect(() => parseMockoonHttpOperations(duplicate, "example-api")).toThrow(
      /duplicate Mockoon HTTP operation/,
    );
  });

  test("keeps partial connector fixtures and local tokenizers fail-closed", () => {
    const missingCases = [
      [
        "@elizaos/plugin-google-workspace",
        "connector-ingress",
        "@elizaos/plugin-google-workspace:connector-ingress:google-chat",
      ],
      [
        "@elizaos/plugin-slack",
        "connector-ingress",
        "@elizaos/plugin-slack:connector-ingress:slack",
      ],
      [
        "@elizaos/plugin-telegram",
        "service",
        "@elizaos/plugin-telegram:service:telegram",
      ],
      ["@elizaos/plugin-x", "service", "@elizaos/plugin-x:service:x"],
      [
        "@elizaos/plugin-calendar",
        "route",
        "@elizaos/plugin-calendar:route:/api/lifeops/calendar/google/webhook",
      ],
      [
        "@elizaos/plugin-anthropic-proxy",
        "action",
        "@elizaos/plugin-anthropic-proxy:action:proxy_status",
      ],
    ] as const;
    for (const [packageName, kind, surfaceId] of missingCases) {
      expect(
        resolveRuntimeDependencies(packageName, kind, undefined, surfaceId)
          .dependencyDisposition,
      ).toBe("mock-missing");
    }

    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-openai",
        "model-handler",
        undefined,
        "@elizaos/plugin-openai:model-handler:text_tokenizer_encode",
      ).dependencyDisposition,
    ).toBe("local-only");
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-openai",
        "model-handler",
        undefined,
        "@elizaos/plugin-openai:model-handler:text_small",
      ).dependencyDisposition,
    ).toBe("mock-owned");
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-openai",
        "model-handler",
        undefined,
        "@elizaos/plugin-openai:model-handler:research",
      ).dependencyDisposition,
    ).toBe("mock-missing");
    expect(
      resolveRuntimeDependencies(
        "@elizaos/plugin-anthropic-proxy",
        "service",
        undefined,
        "@elizaos/plugin-anthropic-proxy:service:anthropic-proxy",
      ).dependencyDisposition,
    ).toBe("mock-missing");
  });

  test("the committed catalog is versioned and records its closed design reference", () => {
    const committed = loadRuntimeDependencyCatalog();
    expect(committed.schema).toBe(RUNTIME_DEPENDENCY_SCHEMA);
    expect(committed.upstreamCatalog).toMatchObject({
      pullRequest: 23185,
      head: "0f14c26c6ae4b28771d984c32e8d1fd79c7929ee",
    });
    expect(committed.rules).toHaveLength(55);
    expect(Object.keys(committed.localPackages)).toHaveLength(0);
    expect(committed.rules.every((rule) => Array.isArray(rule.kinds))).toBe(
      true,
    );
    expect(
      new Set([
        ...committed.rules.map((rule) => rule.packageName),
        ...Object.keys(committed.localPackages),
      ]).size,
    ).toBe(43);
    expect(
      resolveRuntimeDependencies(
        "@elizaos/cloud-api",
        "route",
        committed,
        "@elizaos/cloud-api:route:get-/api/i18n/locale",
      ),
    ).toEqual({
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "local-only",
    });
  });
});
