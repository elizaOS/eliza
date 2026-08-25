/** Exercises the atomic, fail-closed managed activation-routing reader. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
  ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
  type ActivationRoutingSnapshotReader,
  readActivationRoutingState,
} from "../src/activation-routing";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const GENERATION = "00000000-0000-4000-8000-000000000002";
const OTHER_GENERATION = "00000000-0000-4000-8000-000000000003";
const PUBLICATION_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_PUBLICATION_ID = "00000000-0000-4000-8000-000000000005";
const RUNTIME_AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee6";
const OTHER_RUNTIME_AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee7";
const ENDPOINT_SHA256 =
  "7278b3fce767689aae03cb1df507ec11dd20ed8c192c67ace95c57e0bb67bbdd";
const OTHER_ENDPOINT_SHA256 = "b".repeat(64);
const SNAPSHOT_MISSING_SENTINEL = "activation-routing-missing:v1";
const SNAPSHOT_SENTINEL = "activation-routing-snapshot:v1";
const SNAPSHOT_VALUE_PREFIX = "activation-routing:v1:";

const MARKER = JSON.stringify({ version: 1, managed: true });
const ACTIVE_AUTHORITY = JSON.stringify({
  version: 1,
  state: "active",
  generation: GENERATION,
  publicationId: PUBLICATION_ID,
  endpointSha256: ENDPOINT_SHA256,
});
const TRANSITION_AUTHORITY = JSON.stringify({
  version: 1,
  state: "transition",
  generation: GENERATION,
  publicationId: null,
  endpointSha256: null,
});
const REVOKED_AUTHORITY = JSON.stringify({
  version: 1,
  state: "revoked",
  generation: GENERATION,
  publicationId: null,
  endpointSha256: null,
});

interface EndpointFixture {
  version: number;
  generation: string;
  kind: string;
  serverName: string;
  runtimeAgentId: string;
  registryUrl: string;
  bridgeUrl: string;
  healthUrl: string;
}

const ENDPOINT: EndpointFixture = {
  version: 1,
  generation: GENERATION,
  kind: "dedicated-sandbox",
  serverName: `sandbox-${GENERATION}`,
  runtimeAgentId: RUNTIME_AGENT_ID,
  registryUrl: "https://sandbox.internal:3000/",
  bridgeUrl: "http://100.64.0.2:3000",
  healthUrl: "http://100.64.0.2:3000/health",
};

function route(
  overrides: Partial<{
    version: number;
    kind: string;
    generation: string;
    publicationId: string;
    endpointSha256: string;
    endpoint: unknown;
  }> = {},
): string {
  return JSON.stringify({
    version: 1,
    kind: "dedicated-sandbox",
    generation: GENERATION,
    publicationId: PUBLICATION_ID,
    endpointSha256: ENDPOINT_SHA256,
    endpoint: ENDPOINT,
    ...overrides,
  });
}

function routeWithEndpoint(overrides: Record<string, unknown>): string {
  return route({ endpoint: { ...ENDPOINT, ...overrides } });
}

class SnapshotReaderProbe implements ActivationRoutingSnapshotReader {
  readonly snapshotCalls: Array<readonly string[]> = [];
  evalCalls = 0;
  getCalls = 0;

  constructor(
    private readonly snapshot: unknown,
    private readonly snapshotError?: Error,
  ) {}

  async readActivationRoutingSnapshot(
    keys: readonly [string, string, string],
  ): Promise<unknown> {
    this.snapshotCalls.push([...keys]);
    if (this.snapshotError) throw this.snapshotError;
    return Array.isArray(this.snapshot)
      ? [
          SNAPSHOT_SENTINEL,
          ...this.snapshot.map((value) =>
            value === null
              ? SNAPSHOT_MISSING_SENTINEL
              : typeof value === "string"
                ? `${SNAPSHOT_VALUE_PREFIX}${value}`
                : value,
          ),
        ]
      : this.snapshot;
  }

  async eval(): Promise<never> {
    this.evalCalls += 1;
    throw new Error("generic EVAL must not be called");
  }

  async get(): Promise<never> {
    this.getCalls += 1;
    throw new Error("legacy/non-atomic GET must not be called");
  }
}

async function read(snapshot: unknown) {
  return readActivationRoutingState(
    new SnapshotReaderProbe(snapshot),
    AGENT_ID,
  );
}

describe("atomic activation-routing reader", () => {
  test("uses exactly one purpose-bound snapshot read over the canonical keys", async () => {
    const reader = new SnapshotReaderProbe([MARKER, ACTIVE_AUTHORITY, route()]);

    await expect(
      readActivationRoutingState(reader, AGENT_ID),
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(reader.snapshotCalls).toEqual([
      [
        `agent:${AGENT_ID}:routing-managed`,
        `agent:${AGENT_ID}:registration-authority`,
        `agent:${AGENT_ID}:activation-route`,
      ],
    ]);
    expect(reader.evalCalls).toBe(0);
    expect(reader.getCalls).toBe(0);
  });

  test("returns unmanaged only when all three new keys are absent", async () => {
    await expect(read([null, null, null])).resolves.toEqual({
      status: "unmanaged",
    });
    await expect(read([null, ACTIVE_AUTHORITY, null])).resolves.toEqual({
      status: "conflict",
      reason: "partial_managed_state",
    });
    await expect(read([null, null, route()])).resolves.toEqual({
      status: "conflict",
      reason: "partial_managed_state",
    });
  });

  test.each([
    "not-json",
    "null",
    JSON.stringify({ version: 1, managed: false }),
    JSON.stringify({ version: 2, managed: true }),
    JSON.stringify({ version: 1, managed: true, extra: true }),
  ])("fails closed for a malformed managed marker: %s", async (rawMarker) => {
    await expect(read([rawMarker, ACTIVE_AUTHORITY, route()])).resolves.toEqual(
      {
        status: "authority_unavailable",
        reason: "invalid_marker",
      },
    );
  });

  test("fails closed when durable registration authority is missing", async () => {
    await expect(read([MARKER, null, route()])).resolves.toEqual({
      status: "authority_unavailable",
      reason: "authority_missing",
    });
  });

  test.each([
    "not-json",
    JSON.stringify({
      version: 1,
      state: "active",
      generation: "00000000-0000-4A00-8000-000000000002",
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256,
    }),
    JSON.stringify({
      version: 1,
      state: "active",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256.toUpperCase(),
    }),
    JSON.stringify({
      version: 1,
      state: "transition",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: null,
    }),
    JSON.stringify({
      version: 1,
      state: "active",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256,
      extra: true,
    }),
  ])(
    "fails closed for malformed authority JSON or shape: %s",
    async (rawAuthority) => {
      await expect(read([MARKER, rawAuthority, route()])).resolves.toEqual({
        status: "authority_unavailable",
        reason: "invalid_authority",
      });
    },
  );

  test("maps a durable transition to starting without trusting a stale route", async () => {
    await expect(
      read([
        MARKER,
        TRANSITION_AUTHORITY,
        route({
          generation: OTHER_GENERATION,
          endpoint: {
            ...ENDPOINT,
            generation: OTHER_GENERATION,
            serverName: `sandbox-${OTHER_GENERATION}`,
          },
        }),
      ]),
    ).resolves.toMatchObject({
      status: "starting",
      authority: { state: "transition" },
    });
  });

  test("maps a durable tombstone to revoked even when a stale TTL route remains", async () => {
    await expect(
      read([MARKER, REVOKED_AUTHORITY, route()]),
    ).resolves.toMatchObject({
      status: "revoked",
      authority: { state: "revoked" },
    });
  });

  test("maps an active authority without its TTL route to starting", async () => {
    await expect(read([MARKER, ACTIVE_AUTHORITY, null])).resolves.toMatchObject(
      {
        status: "starting",
        authority: { state: "active" },
      },
    );
  });

  test.each([
    "not-json",
    "[]",
    JSON.stringify({
      version: 1,
      kind: "dedicated-sandbox",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256,
      endpoint: ENDPOINT,
      extra: true,
    }),
    route({ kind: "shared-runtime" }),
    route({ endpointSha256: ENDPOINT_SHA256.toUpperCase() }),
    routeWithEndpoint({ runtimeAgentId: undefined }),
    routeWithEndpoint({ runtimeAgentId: "not-a-uuid" }),
    routeWithEndpoint({ runtimeAgentId: RUNTIME_AGENT_ID.toUpperCase() }),
    routeWithEndpoint({ extra: true }),
    routeWithEndpoint({ registryUrl: "HTTPS://sandbox.internal" }),
    routeWithEndpoint({ registryUrl: "https://user:secret@sandbox.internal" }),
    routeWithEndpoint({ registryUrl: "http://:80/path" }),
    routeWithEndpoint({ registryUrl: "http://127.0.0.1:0/path" }),
    routeWithEndpoint({ registryUrl: "http://[::1]:3000/path" }),
    routeWithEndpoint({ registryUrl: "https://sandbox.internal./path" }),
    routeWithEndpoint({ registryUrl: "http://999.999/path" }),
    routeWithEndpoint({ registryUrl: "https://tést.internal/path" }),
    routeWithEndpoint({ bridgeUrl: "https://sandbox.internal/?token=secret" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal/health#ready" }),
    routeWithEndpoint({ registryUrl: "https://sandbox.internal\\evil/path" }),
    routeWithEndpoint({ healthUrl: " https://sandbox.internal/health" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal/a\u00a0b" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal/a\u202fb" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal/a\ufeffb" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal/café" }),
    routeWithEndpoint({ healthUrl: "https://sandbox.internal:65536/health" }),
  ])("rejects malformed route JSON or shape: %s", async (rawRoute) => {
    await expect(read([MARKER, ACTIVE_AUTHORITY, rawRoute])).resolves.toEqual({
      status: "conflict",
      reason: "invalid_route",
    });
  });

  test.each([
    [
      route({
        generation: OTHER_GENERATION,
        endpoint: {
          ...ENDPOINT,
          generation: OTHER_GENERATION,
          serverName: `sandbox-${OTHER_GENERATION}`,
        },
      }),
      "generation_mismatch",
    ],
    [route({ publicationId: OTHER_PUBLICATION_ID }), "publication_mismatch"],
    [
      route({ endpointSha256: OTHER_ENDPOINT_SHA256 }),
      "endpoint_hash_mismatch",
    ],
    [
      route({
        endpoint: {
          ...ENDPOINT,
          serverName: `sandbox-${OTHER_GENERATION}`,
        },
      }),
      "invalid_route",
    ],
  ])("rejects authority/route divergence (%s)", async (rawRoute, reason) => {
    await expect(read([MARKER, ACTIVE_AUTHORITY, rawRoute])).resolves.toEqual({
      status: "conflict",
      reason,
    });
  });

  test("returns the exact validated authority and route when ready", async () => {
    await expect(read([MARKER, ACTIVE_AUTHORITY, route()])).resolves.toEqual({
      status: "ready",
      authority: {
        version: 1,
        state: "active",
        generation: GENERATION,
        publicationId: PUBLICATION_ID,
        endpointSha256: ENDPOINT_SHA256,
      },
      route: {
        version: 1,
        kind: "dedicated-sandbox",
        generation: GENERATION,
        publicationId: PUBLICATION_ID,
        endpointSha256: ENDPOINT_SHA256,
        endpoint: ENDPOINT,
      },
    });
  });

  test("rejects a route whose endpoint body no longer matches its content hash", async () => {
    await expect(
      read([
        MARKER,
        ACTIVE_AUTHORITY,
        route({
          endpoint: {
            ...ENDPOINT,
            registryUrl: "https://attacker-selected.invalid/",
          },
        }),
      ]),
    ).resolves.toEqual({
      status: "conflict",
      reason: "endpoint_hash_mismatch",
    });
    await expect(
      read([
        MARKER,
        ACTIVE_AUTHORITY,
        route({
          endpoint: {
            ...ENDPOINT,
            runtimeAgentId: OTHER_RUNTIME_AGENT_ID,
          },
        }),
      ]),
    ).resolves.toEqual({
      status: "conflict",
      reason: "endpoint_hash_mismatch",
    });
  });

  test.each([1, 65535])("accepts the V1 TCP port boundary %d", async (port) => {
    const endpoint = {
      ...ENDPOINT,
      bridgeUrl: `http://127.0.0.1:${port}/bridge`,
    };
    const endpointSha256 = createHash("sha256")
      .update(JSON.stringify(endpoint), "utf8")
      .digest("hex");
    const authority = JSON.stringify({
      version: 1,
      state: "active",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256,
    });

    await expect(
      read([MARKER, authority, route({ endpoint, endpointSha256 })]),
    ).resolves.toMatchObject({
      status: "ready",
      route: { endpoint },
    });
  });

  test("fails closed for an invalid snapshot envelope or reader error", async () => {
    await expect(read([MARKER, ACTIVE_AUTHORITY])).resolves.toEqual({
      status: "authority_unavailable",
      reason: "invalid_snapshot",
    });

    const reader = new SnapshotReaderProbe(
      null,
      new Error("redis unavailable"),
    );
    await expect(readActivationRoutingState(reader, AGENT_ID)).resolves.toEqual(
      {
        status: "authority_unavailable",
        reason: "redis_unavailable",
      },
    );
    expect(reader.snapshotCalls).toHaveLength(1);
    expect(reader.evalCalls).toBe(0);
    expect(reader.getCalls).toBe(0);
  });

  test("keeps Redis EVAL_RO and Upstash read-only script contracts distinct", () => {
    const upstashShebang = "#!lua flags=no-writes,allow-key-locking\n";

    expect(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT.startsWith("#!lua")).toBe(
      false,
    );
    expect(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT).not.toContain(
      "allow-key-locking",
    );
    expect(
      ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT.startsWith(upstashShebang),
    ).toBe(true);
    expect(
      ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT.slice(upstashShebang.length),
    ).toBe(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT);
  });

  test("requires the Lua presence envelope that defeats Upstash JSON auto-deserialization", async () => {
    const reader = new SnapshotReaderProbe([MARKER, ACTIVE_AUTHORITY, route()]);
    await expect(
      readActivationRoutingState(reader, AGENT_ID),
    ).resolves.toMatchObject({
      status: "ready",
    });
    expect(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT).toContain(
      `return "${SNAPSHOT_VALUE_PREFIX}" .. value`,
    );
    expect(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT).toContain(
      `return "${SNAPSHOT_MISSING_SENTINEL}"`,
    );
    expect(ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT).toContain(
      `"${SNAPSHOT_SENTINEL}"`,
    );

    const unenvelopedReader: ActivationRoutingSnapshotReader = {
      async readActivationRoutingSnapshot() {
        return [
          JSON.parse(MARKER),
          JSON.parse(ACTIVE_AUTHORITY),
          JSON.parse(route()),
        ];
      },
    };
    await expect(
      readActivationRoutingState(unenvelopedReader, AGENT_ID),
    ).resolves.toEqual({
      status: "authority_unavailable",
      reason: "invalid_snapshot",
    });

    const wrongSentinelReader: ActivationRoutingSnapshotReader = {
      async readActivationRoutingSnapshot() {
        return [
          "activation-routing-snapshot:v2",
          `${SNAPSHOT_VALUE_PREFIX}${MARKER}`,
          `${SNAPSHOT_VALUE_PREFIX}${ACTIVE_AUTHORITY}`,
          `${SNAPSHOT_VALUE_PREFIX}${route()}`,
        ];
      },
    };
    await expect(
      readActivationRoutingState(wrongSentinelReader, AGENT_ID),
    ).resolves.toEqual({
      status: "authority_unavailable",
      reason: "invalid_snapshot",
    });

    const exactMissingEnvelopeReader: ActivationRoutingSnapshotReader = {
      async readActivationRoutingSnapshot() {
        return [
          SNAPSHOT_SENTINEL,
          SNAPSHOT_MISSING_SENTINEL,
          SNAPSHOT_MISSING_SENTINEL,
          SNAPSHOT_MISSING_SENTINEL,
        ];
      },
    };
    await expect(
      readActivationRoutingState(exactMissingEnvelopeReader, AGENT_ID),
    ).resolves.toEqual({ status: "unmanaged" });
  });

  test.each([null, false])(
    "rejects a raw RESP missing value outside the versioned protocol: %p",
    async (rawMissing) => {
      const reader: ActivationRoutingSnapshotReader = {
        async readActivationRoutingSnapshot() {
          return [
            SNAPSHOT_SENTINEL,
            `${SNAPSHOT_VALUE_PREFIX}${MARKER}`,
            rawMissing,
            `${SNAPSHOT_VALUE_PREFIX}${route()}`,
          ];
        },
      };
      await expect(
        readActivationRoutingState(reader, AGENT_ID),
      ).resolves.toEqual({
        status: "authority_unavailable",
        reason: "invalid_snapshot",
      });
    },
  );

  test("rejects a non-canonical agent id before constructing Redis keys", async () => {
    const reader = new SnapshotReaderProbe([null, null, null]);
    await expect(
      readActivationRoutingState(
        reader,
        "00000000-0000-4A00-8000-000000000001",
      ),
    ).resolves.toEqual({
      status: "authority_unavailable",
      reason: "invalid_agent_id",
    });
    expect(reader.snapshotCalls).toHaveLength(0);
    expect(reader.evalCalls).toBe(0);
    expect(reader.getCalls).toBe(0);
  });
});
