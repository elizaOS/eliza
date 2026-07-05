/**
 * Pins the fail-closed / designed-empty contract of the container row->DTO
 * mapper (#13415). `metadata.ts` is pure synchronous projection — no catch,
 * no cloud-API call — so the error-policy concern here is that a designed
 * "no Hetzner node" result (null) stays DISTINCT from a well-formed present
 * result, and that a structurally-invalid Hetzner blob degrades to that same
 * null (which callers branch on to skip remote teardown) rather than
 * fabricating a half-populated metadata object that would drive an SSH exec
 * against garbage.
 */

import { describe, expect, it } from "bun:test";
import type { Container } from "../../../../db/repositories/containers";
import { readMetadata, rowToSummary } from "./metadata";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Partial<Container> = {}): Container {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "agent-one",
    project_name: "proj",
    description: null,
    organization_id: "22222222-2222-2222-2222-222222222222",
    user_id: "33333333-3333-3333-3333-333333333333",
    api_key_id: null,
    character_id: null,
    load_balancer_url: null,
    public_hostname: null,
    status: "running",
    image_tag: null,
    environment_vars: {},
    desired_count: 1,
    cpu: 1792,
    memory: 1792,
    port: 3000,
    health_check_path: "/health",
    node_id: null,
    volume_path: null,
    volume_size_gb: null,
    hcloud_volume_id: null,
    volume_location: null,
    last_deployed_at: null,
    last_health_check: null,
    deployment_log: null,
    deployment_log_storage: "inline",
    deployment_log_key: null,
    error_message: null,
    metadata: {},
    last_billed_at: null,
    next_billing_at: null,
    billing_status: "active",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    total_billed: "0.00",
    created_at: NOW,
    updated_at: NOW,
  } as unknown as Container;
  return { ...base, ...overrides };
}

const validHetznerMeta = {
  provider: "hetzner-docker",
  nodeId: "node-1",
  hostname: "10.0.0.5",
  containerName: "cloud-container-abc",
  hostPort: 49001,
  image: "ghcr.io/elizaos/eliza:stable",
  containerPort: 3000,
};

describe("readMetadata — present vs designed-empty stay distinct", () => {
  it("returns the fully typed blob for a well-formed hetzner row (present)", () => {
    const meta = readMetadata(makeRow({ metadata: { ...validHetznerMeta } }));
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({
      provider: "hetzner-docker",
      nodeId: "node-1",
      hostname: "10.0.0.5",
      containerName: "cloud-container-abc",
      hostPort: 49001,
      image: "ghcr.io/elizaos/eliza:stable",
      containerPort: 3000,
    });
  });

  it("returns null (designed-empty) for a legacy AWS row, never throws", () => {
    const awsRow = makeRow({
      metadata: { provider: "aws-ecs", ecr_image_uri: "123.dkr.ecr/eliza:1" },
    });
    expect(() => readMetadata(awsRow)).not.toThrow();
    expect(readMetadata(awsRow)).toBeNull();
  });

  it("returns null for an absent/empty metadata blob, never throws", () => {
    expect(readMetadata(makeRow({ metadata: {} }))).toBeNull();
    expect(readMetadata(makeRow({ metadata: null as never }))).toBeNull();
  });
});

describe("readMetadata — a structurally-invalid hetzner blob degrades to null, not a fabricated object", () => {
  // A hetzner-provider row that is missing/mistyping a required field must NOT
  // read as a half-valid metadata object: callers gate remote docker teardown
  // on `if (meta)` and would SSH-exec against a bad hostname/containerName.
  const requiredFieldMutations: Array<[string, Record<string, unknown>]> = [
    ["hostPort is a string, not a number", { ...validHetznerMeta, hostPort: "49001" }],
    [
      "containerPort missing",
      (() => {
        const m = { ...validHetznerMeta };
        delete (m as Record<string, unknown>).containerPort;
        return m;
      })(),
    ],
    [
      "nodeId missing",
      (() => {
        const m = { ...validHetznerMeta };
        delete (m as Record<string, unknown>).nodeId;
        return m;
      })(),
    ],
    ["hostname is null", { ...validHetznerMeta, hostname: null }],
    ["containerName is a number", { ...validHetznerMeta, containerName: 42 }],
    [
      "image missing",
      (() => {
        const m = { ...validHetznerMeta };
        delete (m as Record<string, unknown>).image;
        return m;
      })(),
    ],
  ];

  for (const [label, metadata] of requiredFieldMutations) {
    it(`returns null when ${label}`, () => {
      expect(readMetadata(makeRow({ metadata }))).toBeNull();
    });
  }

  it("keeps genuinely-optional fields absent without discarding the row", () => {
    const meta = readMetadata(makeRow({ metadata: { ...validHetznerMeta } }));
    expect(meta).not.toBeNull();
    // Optional fields are `undefined` when absent — distinct from the whole
    // row being rejected as null.
    expect(meta?.imageDigest).toBeUndefined();
    expect(meta?.volumePath).toBeUndefined();
    expect(meta?.volumeMountPath).toBeUndefined();
  });
});

describe("rowToSummary — projection keeps present metadata distinct from null", () => {
  it("carries a valid hetzner blob through as summary.metadata (present)", () => {
    const summary = rowToSummary(
      makeRow({
        metadata: { ...validHetznerMeta },
        load_balancer_url: "https://x.containers.elizacloud.ai",
        error_message: null,
      }),
    );
    expect(summary.metadata).not.toBeNull();
    expect(summary.metadata?.provider).toBe("hetzner-docker");
    expect(summary.image).toBe("ghcr.io/elizaos/eliza:stable");
    expect(summary.publicUrl).toBe("https://x.containers.elizacloud.ai");
  });

  it("yields metadata:null for a legacy AWS row while still projecting its image, never throws", () => {
    const summary = rowToSummary(
      makeRow({ metadata: { provider: "aws-ecs", ecr_image_uri: "123.dkr.ecr/eliza:1" } }),
    );
    // metadata:null is the designed distinct signal (no hetzner node); the
    // legacy image still projects rather than being lost.
    expect(summary.metadata).toBeNull();
    expect(summary.image).toBe("123.dkr.ecr/eliza:1");
  });

  it("projects nullable columns as null, not fabricated values", () => {
    const summary = rowToSummary(makeRow({ load_balancer_url: null, error_message: null }));
    expect(summary.publicUrl).toBeNull();
    expect(summary.errorMessage).toBeNull();
    expect(summary.metadata).toBeNull();
  });
});
