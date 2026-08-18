/**
 * Guards the embedding-sidecar contract: the ensure/probe shell commands and
 * probe parser every consumer (cloud-init bootstrap, operator onboard, health
 * loop) shares. Deterministic — the builders are pure; no SSH or docker here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildEmbeddingSidecarProbeCmd,
  buildEnsureEmbeddingSidecarCmd,
  EMBEDDING_SIDECAR_CONFIG_LABEL,
  EMBEDDING_SIDECAR_CONTAINER_NAME,
  EMBEDDING_SIDECAR_SPACE_LABEL,
  embeddingSidecarStatusFromMetadata,
  parseEmbeddingSidecarProbe,
  resolveEmbeddingSidecarConfig,
} from "./embedding-sidecar";

const SIDECAR_ENV_KEYS = [
  "CONTAINERS_EMBEDDING_SIDECAR_IMAGE",
  "ELIZA_EMBEDDING_SIDECAR_IMAGE",
  "CONTAINERS_EMBEDDING_SIDECAR_MODEL_ID",
  "ELIZA_EMBEDDING_SIDECAR_MODEL_ID",
  "CONTAINERS_EMBEDDING_SIDECAR_HOST_PORT",
  "ELIZA_EMBEDDING_SIDECAR_HOST_PORT",
];

afterEach(() => {
  for (const key of SIDECAR_ENV_KEYS) delete process.env[key];
});

describe("buildEnsureEmbeddingSidecarCmd", () => {
  test("is idempotent only for the exact running canonical config", () => {
    const cmd = buildEnsureEmbeddingSidecarCmd();
    expect(cmd).toContain(`{{index .Config.Labels "${EMBEDDING_SIDECAR_SPACE_LABEL}"}}`);
    expect(cmd).toContain(`{{index .Config.Labels "${EMBEDDING_SIDECAR_CONFIG_LABEL}"}}`);
    expect(cmd).toContain("grep -Fqx 'true|BAAI/bge-small-en-v1.5:384:cls:l2:v2|");
    expect(cmd).not.toContain("BAAI/bge-small-en-v1.5:384:mean:l2:v1");
    // A running legacy/unlabelled GTE container or any image/network/port drift
    // misses the exact label identity and is replaced, rather than docker-started.
    expect(cmd).toContain(
      `docker rm -f ${EMBEDDING_SIDECAR_CONTAINER_NAME} >/dev/null 2>&1 || true`,
    );
  });

  test("supervises via docker restart policy and survives the disk-clean prune", () => {
    const cmd = buildEnsureEmbeddingSidecarCmd();
    expect(cmd).toContain("--restart always");
    // The disk-clean cycle prunes stopped containers NOT carrying the
    // managed-by label — an unlabeled sidecar is exactly how hand-installed
    // ones vanished. The label is load-bearing, not cosmetic.
    expect(cmd).toContain("--label ai.elizaos.managed-by=eliza-cloud");
    expect(cmd).toContain(
      "--label ai.elizaos.embedding-space=BAAI/bge-small-en-v1.5:384:cls:l2:v2",
    );
  });

  test("serves canonical CLS-pooled BGE-small on the shared bridge network", () => {
    const cmd = buildEnsureEmbeddingSidecarCmd();
    expect(cmd).toContain("--network containers-isolated");
    expect(cmd).toContain("-p 127.0.0.1:8290:80");
    expect(cmd).toContain("--model-id BAAI/bge-small-en-v1.5 --pooling cls");
    expect(cmd).not.toContain("--pooling mean");
    expect(cmd).toContain("ghcr.io/huggingface/text-embeddings-inference:cpu-1.8");
    // Model cache persists across container replacement.
    expect(cmd).toContain("-v /data/embedding-models:/data");
  });

  test("single line — embeddable in a cloud-init runcmd entry", () => {
    expect(buildEnsureEmbeddingSidecarCmd()).not.toMatch(/[\r\n]/);
  });

  test("honors image/port overrides but rejects a non-canonical model override", () => {
    process.env.CONTAINERS_EMBEDDING_SIDECAR_IMAGE = "ghcr.io/example/tei:cpu-9.9";
    process.env.CONTAINERS_EMBEDDING_SIDECAR_MODEL_ID = "BAAI/bge-small-en-v1.5";
    process.env.CONTAINERS_EMBEDDING_SIDECAR_HOST_PORT = "9411";
    const cmd = buildEnsureEmbeddingSidecarCmd();
    expect(cmd).toContain("ghcr.io/example/tei:cpu-9.9");
    expect(cmd).toContain("--model-id BAAI/bge-small-en-v1.5");
    expect(cmd).toContain("-p 127.0.0.1:9411:80");

    process.env.CONTAINERS_EMBEDDING_SIDECAR_MODEL_ID = "thenlper/gte-small";
    expect(() => buildEnsureEmbeddingSidecarCmd()).toThrow(/Embedding model mismatch/);
  });

  test("refuses shell-unsafe config instead of quoting around it", () => {
    expect(() =>
      buildEnsureEmbeddingSidecarCmd({
        ...resolveEmbeddingSidecarConfig(),
        image: "evil; rm -rf /",
      }),
    ).toThrow(/refusing to build a shell command/);
    expect(() =>
      buildEnsureEmbeddingSidecarCmd({
        ...resolveEmbeddingSidecarConfig(),
        hostPort: 0,
      }),
    ).toThrow(/invalid host port/);
  });
});

describe("buildEmbeddingSidecarProbeCmd + parseEmbeddingSidecarProbe", () => {
  test("probe emits exactly one status token and the parser round-trips all three", () => {
    const cmd = buildEmbeddingSidecarProbeCmd();
    expect(cmd).toContain("echo running");
    expect(cmd).toContain("echo unresponsive");
    expect(cmd).toContain("echo missing");
    // A healthy-but-legacy GTE container is semantically absent. The probe
    // only reports running when the canonical space label matches exactly.
    expect(cmd).toContain(`{{index .Config.Labels "${EMBEDDING_SIDECAR_SPACE_LABEL}"}}`);
    expect(cmd).toContain("grep -Fqx 'true|BAAI/bge-small-en-v1.5:384:cls:l2:v2'");
    expect(cmd).not.toContain("BAAI/bge-small-en-v1.5:384:mean:l2:v1");
    // HTTP-level: a container that is up but cannot serve must not read present.
    expect(cmd).toContain("curl -fsS -m 5 http://127.0.0.1:8290/health");

    expect(parseEmbeddingSidecarProbe("running\n")).toBe("running");
    expect(parseEmbeddingSidecarProbe("unresponsive")).toBe("unresponsive");
    expect(parseEmbeddingSidecarProbe("missing\n")).toBe("missing");
  });

  test("parser tolerates interleaved stderr/noise and rejects unusable output", () => {
    expect(parseEmbeddingSidecarProbe("[stderr] warning: something\nrunning\n")).toBe("running");
    expect(parseEmbeddingSidecarProbe("motd banner\nmissing")).toBe("missing");
    expect(parseEmbeddingSidecarProbe("")).toBeNull();
    expect(parseEmbeddingSidecarProbe("[stderr] connection reset")).toBeNull();
    expect(parseEmbeddingSidecarProbe("garbage output")).toBeNull();
  });
});

describe("embeddingSidecarStatusFromMetadata", () => {
  test("reads the persisted verdict and defaults to unknown for pre-rollout rows", () => {
    expect(
      embeddingSidecarStatusFromMetadata({
        embeddingSidecar: { status: "missing", checkedAt: "2026-08-05T00:00:00.000Z" },
      }),
    ).toBe("missing");
    expect(embeddingSidecarStatusFromMetadata({ embeddingSidecar: { status: "running" } })).toBe(
      "running",
    );
    expect(embeddingSidecarStatusFromMetadata({})).toBe("unknown");
    expect(embeddingSidecarStatusFromMetadata(null)).toBe("unknown");
    expect(embeddingSidecarStatusFromMetadata({ embeddingSidecar: "corrupt" })).toBe("unknown");
    expect(embeddingSidecarStatusFromMetadata({ embeddingSidecar: { status: "bogus" } })).toBe(
      "unknown",
    );
  });
});
