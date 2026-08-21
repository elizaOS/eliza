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
    expect(committed.rules).toHaveLength(61);
    expect(
      committed.rules.reduce((count, rule) => count + rule.kinds.length, 0),
    ).toBe(94);
  });
});
