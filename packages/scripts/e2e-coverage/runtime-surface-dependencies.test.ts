/**
 * Verifies explicit synthetic-world service and mock ownership independently
 * from package-manager imports. The fixture is deterministic and never loads a
 * provider client, starts a server, or contacts an external service.
 */

import { describe, expect, test } from "bun:test";
import {
  loadRuntimeDependencyCatalog,
  RUNTIME_DEPENDENCY_SCHEMA,
  type RuntimeDependencyCatalog,
  resolveRuntimeDependencies,
  validateRuntimeDependencyCatalog,
} from "./runtime-surface-inventory.ts";

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
  test("does not turn React, Zod, or another package import into a service", () => {
    const resolved = resolveRuntimeDependencies("@elizaos/agent", "provider");
    expect(resolved).toEqual({
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "local-only",
    });
  });

  test("binds an external model protocol to a concrete mock owner and source", () => {
    expect(
      resolveRuntimeDependencies("@elizaos/plugin-openai", "model-handler"),
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
    expect(() =>
      validateRuntimeDependencyCatalog(
        [{ packageName: "@elizaos/missing", kind: "provider" }],
        catalog([localRule]),
      ),
    ).toThrow(/missing=.*@elizaos\/missing:provider.*stale=/);
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
      kinds: "all" as const,
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
        catalog([allKindsRule]),
      ),
    ).toThrow(/missing=.*@elizaos\/missing:service/);
  });

  test("applies external package boundaries to actions, services, and Cloud workers", () => {
    for (const kind of ["action", "service"] as const) {
      expect(
        resolveRuntimeDependencies("@elizaos/plugin-calendar", kind),
      ).toMatchObject({
        dependencyDisposition: "mock-owned",
        externalServiceDependencies: [
          { id: "google-calendar-api", protocol: "Google Calendar API v3" },
        ],
      });
    }
    expect(
      resolveRuntimeDependencies("@elizaos/cloud-api", "scheduled-worker"),
    ).toMatchObject({
      dependencyDisposition: "mock-missing",
      externalServiceDependencies: expect.arrayContaining([
        expect.objectContaining({ id: "postgresql" }),
        expect.objectContaining({ id: "cloudflare-r2" }),
        expect.objectContaining({ id: "redis" }),
        expect.objectContaining({ id: "stripe-api" }),
        expect.objectContaining({ id: "container-control-plane" }),
      ]),
    });
    expect(
      resolveRuntimeDependencies("@elizaos/plugin-goals", "service"),
    ).toEqual({
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "local-only",
    });
  });

  test("rejects a claimed mock whose source does not exist", () => {
    const invalid = catalog([
      {
        packageName: "@elizaos/example",
        kinds: ["connector-ingress"],
        externalServices: [
          {
            id: "example-api",
            protocol: "Example HTTP API",
            mockOwner: "example",
            mockSource: "packages/does-not-exist/mock.json",
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
          },
        ],
        invalid,
      ),
    ).toThrow(/mockSource is missing/);
  });

  test("the committed catalog is versioned and records its closed design reference", () => {
    const committed = loadRuntimeDependencyCatalog();
    expect(committed.schema).toBe(RUNTIME_DEPENDENCY_SCHEMA);
    expect(committed.upstreamCatalog).toMatchObject({
      pullRequest: 23185,
      head: "0f14c26c6ae4b28771d984c32e8d1fd79c7929ee",
    });
    expect(committed.rules).toHaveLength(76);
    expect(Object.keys(committed.localPackages)).toHaveLength(40);
    expect(
      new Set([
        ...committed.rules.map((rule) => rule.packageName),
        ...Object.keys(committed.localPackages),
      ]).size,
    ).toBe(115);
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
