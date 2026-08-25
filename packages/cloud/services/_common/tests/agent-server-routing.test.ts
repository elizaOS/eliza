/** Proves the managed cutover fence and strict raw Redis routing reads. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ActivationRoutingSnapshotKeys,
  type AgentServerRoutingReader,
  resolveAgentServerRouting,
} from "../src";

const MANAGED_AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const RUNTIME_AGENT_ID = "00000000-0000-4000-8000-0000000000b2";
const OTHER_RUNTIME_AGENT_ID = "00000000-0000-4000-8000-0000000000b3";
const GENERATION = "00000000-0000-4000-8000-0000000000c3";
const PUBLICATION_ID = "00000000-0000-4000-8000-0000000000d4";
const ENDPOINT_SHA256 =
  "a095f308eff0a6ed676682a9e493057a02686c3eb36e6eb6046efc5460e15362";
const MANAGED_SERVER_NAME = `sandbox-${GENERATION}`;
const MANAGED_REGISTRY_URL = "https://sandbox.internal:3000/";
const LEGACY_SERVER_NAME = "shared-eliza";
const MANAGED_HEARTBEAT_KEY = `server:${MANAGED_SERVER_NAME}:url`;
const LEGACY_POINTER_KEY = `agent:${RUNTIME_AGENT_ID}:server`;
const LEGACY_HEARTBEAT_KEY = `server:${LEGACY_SERVER_NAME}:url`;
const ACTIVATION_KEYS: ActivationRoutingSnapshotKeys = [
  `agent:${MANAGED_AGENT_ID}:routing-managed`,
  `agent:${MANAGED_AGENT_ID}:registration-authority`,
  `agent:${MANAGED_AGENT_ID}:activation-route`,
];
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
const MANAGED_ENDPOINT = Object.freeze({
  version: 1,
  generation: GENERATION,
  kind: "dedicated-sandbox",
  serverName: MANAGED_SERVER_NAME,
  runtimeAgentId: RUNTIME_AGENT_ID,
  registryUrl: MANAGED_REGISTRY_URL,
  bridgeUrl: "http://100.64.0.3:3000",
  healthUrl: "http://100.64.0.3:3000/health",
});
const MANAGED_ROUTE = JSON.stringify({
  version: 1,
  kind: "dedicated-sandbox",
  generation: GENERATION,
  publicationId: PUBLICATION_ID,
  endpointSha256: ENDPOINT_SHA256,
  endpoint: MANAGED_ENDPOINT,
});

type Snapshot = readonly [string | null, string | null, string | null];

class RoutingReaderProbe implements AgentServerRoutingReader {
  readonly snapshotCalls: ActivationRoutingSnapshotKeys[] = [];
  readonly valueCalls: string[] = [];
  readonly values = new Map<string, unknown>();
  readonly nextSnapshots: Snapshot[] = [];
  readonly nextValues = new Map<string, unknown[]>();
  readonly throwingValueKeys = new Set<string>();

  constructor(
    private readonly snapshot: Snapshot,
    private readonly snapshotError?: Error,
  ) {}

  async readActivationRoutingSnapshot(
    keys: ActivationRoutingSnapshotKeys,
  ): Promise<unknown> {
    this.snapshotCalls.push([...keys] as ActivationRoutingSnapshotKeys);
    if (this.snapshotError) throw this.snapshotError;
    const snapshot =
      this.snapshotCalls.length === 1
        ? this.snapshot
        : (this.nextSnapshots.shift() ?? this.snapshot);
    return [
      SNAPSHOT_SENTINEL,
      ...snapshot.map((value) =>
        value === null
          ? SNAPSHOT_MISSING_SENTINEL
          : `${SNAPSHOT_VALUE_PREFIX}${value}`,
      ),
    ];
  }

  async readAgentServerRoutingValue(key: string): Promise<unknown> {
    this.valueCalls.push(key);
    if (this.throwingValueKeys.has(key)) throw new Error("redis unavailable");
    const queued = this.nextValues.get(key);
    if (queued && queued.length > 0) return queued.shift();
    return this.values.has(key) ? this.values.get(key) : null;
  }
}

function reader(snapshot: Snapshot): RoutingReaderProbe {
  return new RoutingReaderProbe(snapshot);
}

function resolve(probe: RoutingReaderProbe) {
  return resolveAgentServerRouting(probe, {
    managedAgentId: MANAGED_AGENT_ID,
    runtimeAgentId: RUNTIME_AGENT_ID,
  });
}

describe("agent-server routing authority", () => {
  test("validates both identities before any Redis read", async () => {
    const invalidManaged = reader([null, null, null]);
    await expect(
      resolveAgentServerRouting(invalidManaged, {
        managedAgentId: "not-a-uuid",
        runtimeAgentId: RUNTIME_AGENT_ID,
      }),
    ).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "invalid_managed_agent_id",
    });
    expect(invalidManaged.snapshotCalls).toHaveLength(0);
    expect(invalidManaged.valueCalls).toHaveLength(0);

    const invalidRuntime = reader([null, null, null]);
    await expect(
      resolveAgentServerRouting(invalidRuntime, {
        managedAgentId: MANAGED_AGENT_ID,
        runtimeAgentId: `${RUNTIME_AGENT_ID} `,
      }),
    ).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "invalid_runtime_agent_id",
    });
    expect(invalidRuntime.snapshotCalls).toHaveLength(0);
    expect(invalidRuntime.valueCalls).toHaveLength(0);

    const uppercaseManaged = reader([null, null, null]);
    await expect(
      resolveAgentServerRouting(uppercaseManaged, {
        managedAgentId: MANAGED_AGENT_ID.toUpperCase(),
        runtimeAgentId: RUNTIME_AGENT_ID,
      }),
    ).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "invalid_managed_agent_id",
    });
    expect(uppercaseManaged.snapshotCalls).toHaveLength(0);
    expect(uppercaseManaged.valueCalls).toHaveLength(0);

    const uppercaseRuntime = reader([null, null, null]);
    await expect(
      resolveAgentServerRouting(uppercaseRuntime, {
        managedAgentId: MANAGED_AGENT_ID,
        runtimeAgentId: RUNTIME_AGENT_ID.toUpperCase(),
      }),
    ).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "invalid_runtime_agent_id",
    });
    expect(uppercaseRuntime.snapshotCalls).toHaveLength(0);
    expect(uppercaseRuntime.valueCalls).toHaveLength(0);
  });

  test("uses distinct canonical managed and runtime identities without inverting them", async () => {
    const probe = reader([null, null, null]);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
    probe.values.set(LEGACY_HEARTBEAT_KEY, "http://shared-eliza.internal:3000");

    await expect(
      resolveAgentServerRouting(probe, {
        managedAgentId: MANAGED_AGENT_ID,
        runtimeAgentId: RUNTIME_AGENT_ID,
      }),
    ).resolves.toEqual({
      kind: "ready",
      mode: "legacy",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: LEGACY_SERVER_NAME,
      serverUrl: "http://shared-eliza.internal:3000",
    });
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
    expect(probe.valueCalls).toEqual([
      LEGACY_POINTER_KEY,
      LEGACY_HEARTBEAT_KEY,
      LEGACY_POINTER_KEY,
    ]);
    expect(probe.valueCalls).not.toContain(`agent:${MANAGED_AGENT_ID}:server`);
  });

  test("returns unregistered only for a truly absent unmanaged legacy pointer", async () => {
    const probe = reader([null, null, null]);
    await expect(resolve(probe)).resolves.toEqual({
      kind: "unregistered",
      mode: "legacy",
      reason: "legacy_pointer_missing",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
    expect(probe.valueCalls).toEqual([LEGACY_POINTER_KEY, LEGACY_POINTER_KEY]);
  });

  test("returns legacy unreachable only for a truly absent heartbeat", async () => {
    const probe = reader([null, null, null]);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
    await expect(resolve(probe)).resolves.toEqual({
      kind: "unreachable",
      mode: "legacy",
      reason: "heartbeat_missing",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: LEGACY_SERVER_NAME,
    });
    expect(probe.valueCalls).toEqual([
      LEGACY_POINTER_KEY,
      LEGACY_HEARTBEAT_KEY,
      LEGACY_POINTER_KEY,
    ]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test.each([
    "",
    "null",
    "Shared-Eliza",
    "shared/eliza",
    "shared:eliza",
    "a".repeat(129),
    42,
    false,
    { serverName: LEGACY_SERVER_NAME },
  ])("fails closed for an invalid legacy pointer: %p", async (value) => {
    const probe = reader([null, null, null]);
    probe.values.set(LEGACY_POINTER_KEY, value);
    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "legacy",
      reason: "invalid_legacy_pointer",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.valueCalls).toEqual([LEGACY_POINTER_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("accepts the existing Docker sandbox registry server-name shape", async () => {
    const dockerServerName = `sandbox-${RUNTIME_AGENT_ID}-${GENERATION}`;
    expect(dockerServerName).toHaveLength(81);
    const probe = reader([null, null, null]);
    probe.values.set(LEGACY_POINTER_KEY, dockerServerName);
    probe.values.set(
      `server:${dockerServerName}:url`,
      "http://docker-sandbox.internal:3000/api",
    );

    await expect(resolve(probe)).resolves.toMatchObject({
      kind: "ready",
      mode: "legacy",
      serverName: dockerServerName,
      serverUrl: "http://docker-sandbox.internal:3000/api",
    });
    expect(probe.valueCalls).toEqual([
      LEGACY_POINTER_KEY,
      `server:${dockerServerName}:url`,
      LEGACY_POINTER_KEY,
    ]);
  });

  test("fails closed when the legacy pointer read throws", async () => {
    const probe = reader([null, null, null]);
    probe.throwingValueKeys.add(LEGACY_POINTER_KEY);
    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "legacy",
      reason: "legacy_pointer_unavailable",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.valueCalls).toEqual([LEGACY_POINTER_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("managed ready reads only the exact managed heartbeat", async () => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(MANAGED_HEARTBEAT_KEY, MANAGED_REGISTRY_URL);
    probe.values.set(LEGACY_POINTER_KEY, "attacker-selected-server");

    await expect(resolve(probe)).resolves.toEqual({
      kind: "ready",
      mode: "managed",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
      serverUrl: MANAGED_REGISTRY_URL,
    });
    expect(probe.valueCalls).toEqual([MANAGED_HEARTBEAT_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects a content-addressed managed route for another runtime before heartbeat", async () => {
    const endpoint = {
      ...MANAGED_ENDPOINT,
      runtimeAgentId: OTHER_RUNTIME_AGENT_ID,
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
    const route = JSON.stringify({
      version: 1,
      kind: "dedicated-sandbox",
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256,
      endpoint,
    });
    const probe = reader([MARKER, authority, route]);
    probe.values.set(MANAGED_HEARTBEAT_KEY, MANAGED_REGISTRY_URL);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "managed",
      reason: "managed_endpoint_mismatch",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
    });
    expect(probe.valueCalls).toHaveLength(0);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS]);
  });

  test("managed ready without a heartbeat is unreachable and never falls back", async () => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
    probe.values.set(LEGACY_HEARTBEAT_KEY, "http://shared-eliza.internal:3000");

    await expect(resolve(probe)).resolves.toEqual({
      kind: "unreachable",
      mode: "managed",
      reason: "heartbeat_missing",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
    });
    expect(probe.valueCalls).toEqual([MANAGED_HEARTBEAT_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects a valid managed heartbeat that diverges from the hashed endpoint", async () => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(
      MANAGED_HEARTBEAT_KEY,
      "https://attacker-selected.invalid/",
    );
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "managed",
      reason: "managed_endpoint_mismatch",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
    });
    expect(probe.valueCalls).toEqual([MANAGED_HEARTBEAT_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects a managed route revoked between snapshot and heartbeat", async () => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.nextSnapshots.push([MARKER, REVOKED_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(MANAGED_HEARTBEAT_KEY, MANAGED_REGISTRY_URL);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "routing_state_changed",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects a legacy route when managed cutover appears during its reads", async () => {
    const probe = reader([null, null, null]);
    probe.nextSnapshots.push([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
    probe.values.set(LEGACY_HEARTBEAT_KEY, "http://shared-eliza.internal:3000");

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "routing_state_changed",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.valueCalls).toEqual([
      LEGACY_POINTER_KEY,
      LEGACY_HEARTBEAT_KEY,
      LEGACY_POINTER_KEY,
    ]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects a legacy route whose pointer changes during resolution", async () => {
    const probe = reader([null, null, null]);
    probe.nextValues.set(LEGACY_POINTER_KEY, [
      LEGACY_SERVER_NAME,
      "other-shared-eliza",
    ]);
    probe.values.set(LEGACY_HEARTBEAT_KEY, "http://shared-eliza.internal:3000");

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "routing_state_changed",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("rejects unregistered when a legacy pointer appears during resolution", async () => {
    const probe = reader([null, null, null]);
    probe.nextValues.set(LEGACY_POINTER_KEY, [null, LEGACY_SERVER_NAME]);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "routing_state_changed",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test.each([
    [MARKER, TRANSITION_AUTHORITY, MANAGED_ROUTE, "starting", undefined],
    [MARKER, ACTIVE_AUTHORITY, null, "starting", undefined],
    [MARKER, REVOKED_AUTHORITY, MANAGED_ROUTE, "revoked", undefined],
    [MARKER, ACTIVE_AUTHORITY, "not-json", "conflict", "invalid_route"],
    [null, ACTIVE_AUTHORITY, null, "conflict", "partial_managed_state"],
  ] as const)(
    "maps every managed non-ready state without a legacy read (%s, %s, %s)",
    async (marker, authority, route, reason, conflictReason) => {
      const probe = reader([marker, authority, route]);
      probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
      const expected = {
        kind: "managed_not_ready",
        mode: "managed",
        reason,
        managedAgentId: MANAGED_AGENT_ID,
        runtimeAgentId: RUNTIME_AGENT_ID,
        ...(conflictReason ? { conflictReason } : {}),
      };

      await expect(resolve(probe)).resolves.toEqual(expected);
      expect(probe.valueCalls).toHaveLength(0);
    },
  );

  test("maps managed authority failures without a legacy read", async () => {
    const invalidMarker = reader([
      JSON.stringify({ version: 1, managed: false }),
      ACTIVE_AUTHORITY,
      MANAGED_ROUTE,
    ]);
    invalidMarker.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);
    await expect(resolve(invalidMarker)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "managed_authority_unavailable",
      authorityReason: "invalid_marker",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(invalidMarker.valueCalls).toHaveLength(0);

    const unavailable = new RoutingReaderProbe(
      [null, null, null],
      new Error("redis unavailable"),
    );
    await expect(resolve(unavailable)).resolves.toEqual({
      kind: "routing_unavailable",
      reason: "managed_authority_unavailable",
      authorityReason: "redis_unavailable",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
    });
    expect(unavailable.valueCalls).toHaveLength(0);
  });

  test.each([
    "",
    "null",
    "HTTPS://sandbox.internal:3000",
    " https://sandbox.internal:3000",
    "https://sandbox.internal:3000/path with-space",
    "https://user:secret@sandbox.internal:3000",
    "https://sandbox.internal:3000/?token=secret",
    "https://sandbox.internal:3000/?",
    "https://sandbox.internal:3000/#ready",
    "https://sandbox.internal:3000/#",
    "https://sandbox.internal\\@evil.test/path",
    "redis://sandbox.internal:6379",
    "http://",
    `https://sandbox.internal/${"a".repeat(4096)}`,
    42,
    false,
    { url: "https://sandbox.internal" },
  ])("fails closed for an invalid heartbeat URL: %p", async (value) => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.values.set(MANAGED_HEARTBEAT_KEY, value);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "managed",
      reason: "invalid_server_url",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
    });
    expect(probe.valueCalls).toEqual([MANAGED_HEARTBEAT_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });

  test("fails closed when a managed heartbeat read throws", async () => {
    const probe = reader([MARKER, ACTIVE_AUTHORITY, MANAGED_ROUTE]);
    probe.throwingValueKeys.add(MANAGED_HEARTBEAT_KEY);
    probe.values.set(LEGACY_POINTER_KEY, LEGACY_SERVER_NAME);

    await expect(resolve(probe)).resolves.toEqual({
      kind: "routing_unavailable",
      mode: "managed",
      reason: "heartbeat_unavailable",
      managedAgentId: MANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: MANAGED_SERVER_NAME,
    });
    expect(probe.valueCalls).toEqual([MANAGED_HEARTBEAT_KEY]);
    expect(probe.snapshotCalls).toEqual([ACTIVATION_KEYS, ACTIVATION_KEYS]);
  });
});
