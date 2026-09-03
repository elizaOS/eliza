/**
 * Exercises the authenticated Gateway recovery ledger, encrypted-plan custody,
 * rotation checkpoints, and fail-closed journal sequencing with mocked APIs.
 */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  appendJournalRecord,
  attestResolutionArtifact,
  attestRollbackPlanArtifact,
  commitPreparedOpen,
  currentRecoveryJob,
  decryptCandidateEnvelope,
  encodeWorkflowCommandData,
  encryptCandidateEnvelope,
  exactArtifactFilesFromZip,
  findPreparedOpenArtifact,
  GitHubApi,
  journalCheckpointPayload,
  main as journalMain,
  journalRecordCommentBody,
  journalRecordDigest,
  journalRecordPayload,
  MARKER_PREFIX,
  markerBody,
  markerDigest,
  parseMarkerComment,
  postAndReadBack,
  preparedOpenDescriptor,
  publishEncryptedPlan,
  RECORD_PREFIX,
  RedactedActionError,
  readJournalState,
  reduceJournal,
  restoreEncryptedPlan,
  validateCurrentRecoveryAttempt,
  validatePreparedOpenArtifact,
  validateSourceAttempt,
  writeRedactedActionFailure,
} from "../gateway-webhook-transaction-journal.mjs";

const repository = "elizaOS/eliza";
const sourceSha = "a".repeat(40);
const recoverySha = "b".repeat(40);
const authKey = "journal-auth-key-".repeat(4);
const planFileNames = [
  "deployment-baseline.json",
  "prior-active-deployments.json",
  "rollback-plan.json",
];

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureCrc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function artifactZip(
  entries: Array<[string, Buffer]>,
  { dataDescriptors = false } = {},
) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes);
    const checksum = fixtureCrc32(bytes);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(dataDescriptors ? 0x0008 : 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(dataDescriptors ? 0 : checksum, 14);
    local.writeUInt32LE(dataDescriptors ? 0 : compressed.length, 18);
    local.writeUInt32LE(dataDescriptors ? 0 : bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    const descriptor = dataDescriptors ? Buffer.alloc(16) : Buffer.alloc(0);
    if (dataDescriptors) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    }
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(dataDescriptors ? 0x0008 : 0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    locals.push(local, compressed, descriptor);
    centrals.push(central);
    localOffset += local.length + compressed.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function planArtifactFixture() {
  const priorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snapshotId = "snapshot_prior_123";
  const entries: Array<[string, Buffer]> = [
    [
      "deployment-baseline.json",
      Buffer.from(JSON.stringify([{ id: priorId }]), "utf8"),
    ],
    [
      "prior-active-deployments.json",
      Buffer.from(
        JSON.stringify({ data: { active: [{ id: priorId, snapshotId }] } }),
        "utf8",
      ),
    ],
    [
      "rollback-plan.json",
      Buffer.from(
        JSON.stringify({
          repository,
          environment: "staging",
          sourceSha,
          workflowRunId: "42",
          workflowRunAttempt: "1",
          priorActiveDeploymentId: priorId,
          priorSnapshotId: snapshotId,
        }),
        "utf8",
      ),
    ],
  ];
  const archiveBytes = artifactZip(entries);
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      files: entries.map(([name, bytes]) => ({
        name,
        sha256: sha256(bytes),
        content: bytes.toString("base64"),
      })),
    }),
    "utf8",
  );
  return {
    entries,
    archiveBytes,
    archiveDigest: sha256(archiveBytes),
    plaintextDigest: sha256(plaintext),
  };
}

function signedMarker(marker: Record<string, unknown>) {
  return marker;
}

function openMarker(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "open",
    repository,
    environment: "staging",
    sourceSha,
    sourceRunId: "42",
    sourceRunAttempt: "1",
    planArtifactName: "gateway-webhook-rollback-plan-staging-42-1",
    planArtifactId: "700",
    planArtifactDigest: "c".repeat(64),
    journalPlanId: "9".repeat(32),
    journalEncryptionKeyId: "6".repeat(64),
    journalPlanPlaintextSha256: "8".repeat(64),
    journalProviderKeyEnvelope: "A".repeat(40),
    journalPlanChunkCommentIds: ["600"],
    journalPlanChunkSha256: ["7".repeat(64)],
    previousCloseCommentId: null,
    previousCloseMarkerSha256: null,
    ...overrides,
  };
}

function closeMarker(overrides: Record<string, unknown> = {}) {
  return signedMarker({
    version: 1,
    kind: "close",
    repository,
    environment: "staging",
    sourceSha,
    sourceRunId: "42",
    sourceRunAttempt: "1",
    openCommentId: "1",
    recoveryRunId: "99",
    recoveryRunAttempt: "2",
    recoveryJobId: "900",
    recoveryJobName: "recover-staging / Reconcile Railway candidate (staging)",
    recoveryWorkflowSha: recoverySha,
    resolutionArtifactName: "gateway-webhook-reconciliation-staging-42-1-99-2",
    resolutionArtifactId: "701",
    resolutionArtifactDigest: "d".repeat(64),
    resolutionReceiptSha256: "e".repeat(64),
    result: "candidate-proven",
    rollbackIntentCount: 0,
    lastRollbackIntentCommentId: null,
    lastRollbackIntentMarkerSha256: null,
    rollbackObservationCount: 0,
    lastRollbackObservationCommentId: null,
    lastRollbackObservationMarkerSha256: null,
    ...overrides,
  });
}

function intentMarker(overrides: Record<string, unknown> = {}) {
  return signedMarker({
    version: 1,
    kind: "rollback-intent",
    repository,
    environment: "staging",
    sourceSha,
    sourceRunId: "42",
    sourceRunAttempt: "1",
    openCommentId: "1",
    recoveryRunId: "99",
    recoveryRunAttempt: "2",
    recoveryJobId: "900",
    recoveryJobName: "recover-staging / Reconcile Railway candidate (staging)",
    recoveryWorkflowSha: recoverySha,
    candidateDeploymentEnvelope: "A".repeat(64),
    candidateDeploymentIdSha256: "3".repeat(64),
    expectedDeploymentMessageSha256: "4".repeat(64),
    providerActiveTopologySha256: "6".repeat(64),
    providerDeploymentIdWatermarkSha256: ["5".repeat(64)],
    ordinal: 1,
    previousIntentCommentId: null,
    previousIntentMarkerSha256: null,
    failedRestorationIdSha256: null,
    ...overrides,
  });
}

function observationMarker(overrides: Record<string, unknown> = {}) {
  return signedMarker({
    version: 1,
    kind: "rollback-observation",
    repository,
    environment: "staging",
    sourceSha,
    sourceRunId: "42",
    sourceRunAttempt: "1",
    openCommentId: "1",
    recoveryRunId: "99",
    recoveryRunAttempt: "2",
    recoveryJobId: "900",
    recoveryJobName: "recover-staging / Reconcile Railway candidate (staging)",
    recoveryWorkflowSha: recoverySha,
    ordinal: 1,
    intentCommentId: "2",
    intentMarkerSha256: "1".repeat(64),
    refinesObservationCommentId: null,
    refinesObservationMarkerSha256: null,
    restorationIdSha256: "5".repeat(64),
    status: "SUCCESS",
    ...overrides,
  });
}

function comment(
  id: number,
  marker: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    body: markerBody(marker),
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    user: { login: "github-actions[bot]", type: "Bot" },
    ...overrides,
  };
}

function recordFromComment(value: Record<string, unknown>) {
  const encoded = String(value.body).slice(RECORD_PREFIX.length, -4);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function writerFor(marker: Record<string, unknown>) {
  if (marker.kind === "open") {
    return {
      event: "workflow_dispatch",
      path: ".github/workflows/deploy-gateway-webhook.yml",
      ref: `refs/heads/${marker.environment === "production" ? "main" : "develop"}`,
      runAttempt: marker.sourceRunAttempt,
      runId: marker.sourceRunId,
      sha: marker.sourceSha,
    };
  }
  return {
    event: "schedule",
    path: ".github/workflows/recover-gateway-webhook-transactions.yml",
    ref: "refs/heads/develop",
    runAttempt: marker.recoveryRunAttempt,
    runId: marker.recoveryRunId,
    sha: marker.recoveryWorkflowSha,
  };
}

function recordCommentChain(markers: Record<string, unknown>[]) {
  const comments: Record<string, unknown>[] = [];
  let previous: Record<string, unknown> | null = null;
  const logicalIds = new Map<string, string>();
  const logicalMarkers = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = { ...markers[index] };
    const id = index + 1;
    for (const key of [
      "previousCloseCommentId",
      "openCommentId",
      "previousIntentCommentId",
      "intentCommentId",
      "refinesObservationCommentId",
      "lastRollbackIntentCommentId",
      "lastRollbackObservationCommentId",
    ]) {
      const value = marker[key];
      if (typeof value === "string" && logicalIds.has(value)) {
        marker[key] = logicalIds.get(value);
      }
    }
    if (
      marker.kind === "open" &&
      typeof marker.previousCloseCommentId === "string"
    ) {
      marker.previousCloseMarkerSha256 = markerDigest(
        logicalMarkers.get(marker.previousCloseCommentId)!,
      );
    }
    if (marker.kind === "rollback-observation") {
      marker.intentMarkerSha256 = markerDigest(
        logicalMarkers.get(String(marker.intentCommentId))!,
      );
      if (typeof marker.refinesObservationCommentId === "string") {
        marker.refinesObservationMarkerSha256 = markerDigest(
          logicalMarkers.get(String(marker.refinesObservationCommentId))!,
        );
      }
    }
    if (marker.kind === "close") {
      if (typeof marker.lastRollbackIntentCommentId === "string") {
        marker.lastRollbackIntentMarkerSha256 = markerDigest(
          logicalMarkers.get(marker.lastRollbackIntentCommentId)!,
        );
      }
      if (typeof marker.lastRollbackObservationCommentId === "string") {
        marker.lastRollbackObservationMarkerSha256 = markerDigest(
          logicalMarkers.get(marker.lastRollbackObservationCommentId)!,
        );
      }
    }
    const writer = writerFor(marker);
    const payload = journalRecordPayload(
      marker,
      previous,
      writer,
      authKey,
      String(id),
    );
    const createdAt = `2026-09-03T00:00:0${index}Z`;
    const recordComment = {
      id,
      body: journalRecordCommentBody(payload),
      created_at: createdAt,
      updated_at: createdAt,
      user: { login: "github-actions[bot]", type: "Bot" },
    };
    comments.push(recordComment);
    logicalIds.set(String(id), String(payload.logicalRecordId));
    logicalMarkers.set(String(payload.logicalRecordId), {
      ...marker,
      commentId: payload.logicalRecordId,
    });
    previous = {
      ...payload,
      recordId: payload.logicalRecordId,
      commentId: String(id),
      recordSha256: journalRecordDigest(payload),
      createdAt,
    };
  }
  return comments;
}

function trustedApi(markers: Record<string, unknown>[]) {
  const comments = recordCommentChain(markers);
  const calls: string[] = [];
  return {
    calls,
    comments,
    request: async (_method: string, endpoint: string) => {
      calls.push(endpoint);
      if (endpoint.startsWith("/issues/29763/comments?")) {
        return [...comments].sort((left, right) => right.id - left.id);
      }
      const exact = endpoint.match(/^\/issues\/comments\/(\d+)$/);
      if (exact) return comments.find((value) => value.id === Number(exact[1]));
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
}

function canonicalForAuthentication(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalForAuthentication);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalForAuthentication((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function resignWithCurrentKey(
  record: Record<string, unknown>,
  currentAuthKey: string,
) {
  const { auth: _auth, ...unsigned } = record;
  return {
    ...unsigned,
    auth: createHmac("sha256", Buffer.from(currentAuthKey.trim(), "utf8"))
      .update("gateway-webhook-transaction-record-auth-v2\0")
      .update(JSON.stringify(canonicalForAuthentication(unsigned)))
      .digest("hex"),
  };
}

describe("durable Gateway transaction journal", () => {
  test("ignores a human lookalike but rejects an edited bot marker", () => {
    const open = openMarker();
    const human = comment(1, open, {
      user: { login: "attacker", type: "User" },
    });
    expect(parseMarkerComment(human)).toBeNull();
    expect(reduceJournal([human], repository, "staging").status).toBe("clear");

    const edited = comment(1, open, {
      updated_at: "2026-09-03T00:00:01Z",
    });
    expect(() => parseMarkerComment(edited)).toThrow("unedited");
    expect(human.body.startsWith(MARKER_PREFIX)).toBe(true);
  });

  test("keeps an unresolved OPEN authoritative without consulting artifact expiry", async () => {
    const api = trustedApi([openMarker()]);
    const state = await readJournalState(api, repository, "staging", authKey);
    expect(state.status).toBe("open");
    expect(state.open.planArtifactId).toBe("700");
    expect(state.openCreatedAt).toBe("2026-09-03T00:00:00Z");
    expect(api.calls.some((endpoint) => endpoint.includes("/artifacts"))).toBe(
      false,
    );
    expect(
      api.calls.some((endpoint) => endpoint.includes("/actions/runs")),
    ).toBe(false);
    expect(
      api.calls.some((endpoint) => endpoint.includes("/issues/29763")),
    ).toBe(true);
  });

  test("rejects an active OPEN whose HMAC writer ref is forged", async () => {
    const api = trustedApi([openMarker()]);
    const marker = openMarker();
    api.comments[0].body = journalRecordCommentBody(
      journalRecordPayload(
        marker,
        null,
        { ...writerFor(marker), ref: "refs/heads/feature/untrusted" },
        authKey,
        "1",
      ),
    );
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow(/writer|HMAC/);
  });

  test("fails closed on an edited authenticated head instead of falling back to older CLEAR", async () => {
    const api = trustedApi([
      openMarker(),
      closeMarker(),
      openMarker({
        sourceRunId: "43",
        sourceRunAttempt: "2",
        sourceSha: "f".repeat(40),
        planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
        planArtifactId: "702",
        planArtifactDigest: "2".repeat(64),
        previousCloseCommentId: "2",
        previousCloseMarkerSha256: markerDigest({
          ...closeMarker(),
          commentId: "2",
        }),
      }),
    ]);
    api.comments[2].body = `${RECORD_PREFIX}corrupted-->`;
    api.comments[2].updated_at = "2026-09-03T00:00:09Z";
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("record-prefix comment was edited");
  });

  test("fails closed when a newer canonical record claims the current key with an invalid HMAC", async () => {
    const api = trustedApi([openMarker(), closeMarker()]);
    const forged = recordFromComment(api.comments[0]);
    forged.auth = "0".repeat(64);
    api.comments.push({
      id: 3,
      body: journalRecordCommentBody(forged),
      created_at: "2026-09-03T00:00:03Z",
      updated_at: "2026-09-03T00:00:03Z",
      user: { login: "github-actions[bot]", type: "Bot" },
    });
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("claims the protected key but fails authentication");
  });

  test("fails closed when the protected HMAC key is missing or mismatched", async () => {
    const api = trustedApi([openMarker()]);
    await expect(
      readJournalState(api, repository, "staging", undefined),
    ).rejects.toThrow("authentication key is missing");
    await expect(
      readJournalState(
        api,
        repository,
        "staging",
        "mismatched-protected-journal-key-".repeat(2),
      ),
    ).rejects.toThrow(/authentication|head|key/);
  });

  test("recovers exact plan bytes from redacted provider-bound chunks without an artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-journal-plan-"));
    const input = join(root, "input");
    const output = join(root, "output");
    mkdirSync(input);
    const priorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const snapshotId = "snapshot_prior_123";
    const fileBytes = new Map([
      [
        "deployment-baseline.json",
        `${JSON.stringify([{ id: priorId, privateCanary: "never-print-this" }])}\n`,
      ],
      [
        "prior-active-deployments.json",
        `${JSON.stringify({ data: { active: [{ id: priorId, snapshotId }] } })}\n`,
      ],
      [
        "rollback-plan.json",
        `${JSON.stringify({ repository, environment: "staging", sourceSha, workflowRunId: "42", workflowRunAttempt: "1", priorActiveDeploymentId: priorId, priorSnapshotId: snapshotId })}\n`,
      ],
    ]);
    for (const [name, bytes] of fileBytes)
      writeFileSync(join(input, name), bytes);
    const privateKeyCanary = "test-only-private-key-material-never-restore";
    writeFileSync(
      join(input, "transaction-signing-private-key.pk8"),
      privateKeyCanary,
    );
    const planArchive = artifactZip(
      planFileNames.map((name) => {
        const value = fileBytes.get(name);
        if (value === undefined) throw new Error(`missing fixture ${name}`);
        return [name, Buffer.from(value, "utf8")] as [string, Buffer];
      }),
    );
    const planArchiveDigest = sha256(planArchive);
    let nextId = 600;
    const comments = new Map<number, Record<string, unknown>>();
    const api = {
      request: async (
        method: string,
        endpoint: string,
        body?: { body: string },
      ) => {
        if (endpoint === "/actions/artifacts/700") {
          return {
            id: 700,
            name: "gateway-webhook-rollback-plan-staging-42-1",
            digest: `sha256:${planArchiveDigest}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            size_in_bytes: planArchive.length,
            workflow_run: { id: 42, head_sha: sourceSha },
          };
        }
        if (method === "POST") {
          const value = {
            id: nextId++,
            body: body?.body,
            created_at: "2026-09-03T00:00:00Z",
            updated_at: "2026-09-03T00:00:00Z",
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          comments.set(value.id, value);
          return value;
        }
        const match = endpoint.match(/^\/issues\/comments\/(\d+)$/);
        if (match) return comments.get(Number(match[1]));
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
      downloadArtifact: async () => planArchive,
    };
    const source = {
      repository,
      environment: "staging",
      sourceSha,
      sourceRunId: "42",
      sourceRunAttempt: "1",
    };
    try {
      const authoritativeBundle = await attestRollbackPlanArtifact(
        api,
        source,
        {
          planArtifactName: "gateway-webhook-rollback-plan-staging-42-1",
          planArtifactId: "700",
          planArtifactDigest: planArchiveDigest,
        },
      );
      const encrypted = await publishEncryptedPlan(
        api,
        source,
        input,
        authKey,
        authoritativeBundle,
      );
      const bodies = [...comments.values()].map((value) => String(value.body));
      expect(bodies.join("\n")).not.toContain(priorId);
      expect(bodies.join("\n")).not.toContain(snapshotId);
      expect(bodies.join("\n")).not.toContain("never-print-this");
      expect(bodies.join("\n")).not.toContain(privateKeyCanary);
      await restoreEncryptedPlan(
        api,
        source,
        { ...openMarker(), ...encrypted },
        output,
        authKey,
      );
      for (const [name, bytes] of fileBytes) {
        expect(readFileSync(join(output, name), "utf8")).toBe(bytes);
      }
      expect(() =>
        readFileSync(join(output, "transaction-signing-private-key.pk8")),
      ).toThrow();

      const wrongOutput = join(root, "wrong-output");
      await expect(
        restoreEncryptedPlan(
          api,
          source,
          { ...openMarker(), ...encrypted },
          wrongOutput,
          "different-protected-auth-key-".repeat(3),
        ),
      ).rejects.toThrow(/key envelope failed authentication|decryption/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("extracts only the exact safe artifact manifest", () => {
    const fixture = planArtifactFixture();
    const files = exactArtifactFilesFromZip(
      fixture.archiveBytes,
      planFileNames,
      "rollback-plan",
      7_000_000,
    );
    expect([...files.keys()]).toEqual(planFileNames);
    for (const [name, bytes] of fixture.entries) {
      expect(files.get(name)).toEqual(bytes);
    }
    const streamingArchive = artifactZip(fixture.entries, {
      dataDescriptors: true,
    });
    expect(
      exactArtifactFilesFromZip(
        streamingArchive,
        planFileNames,
        "rollback-plan",
        7_000_000,
      ),
    ).toEqual(new Map(fixture.entries));
    const changedDescriptor = Buffer.from(streamingArchive);
    const firstNameBytes = Buffer.from(fixture.entries[0][0], "utf8");
    const firstCompressedBytes = deflateRawSync(fixture.entries[0][1]);
    const firstDescriptorOffset =
      30 + firstNameBytes.length + firstCompressedBytes.length;
    changedDescriptor[firstDescriptorOffset + 4] ^= 1;
    expect(() =>
      exactArtifactFilesFromZip(
        changedDescriptor,
        planFileNames,
        "rollback-plan",
        7_000_000,
      ),
    ).toThrow("data descriptor is inconsistent");

    const extraFile = artifactZip([
      ...fixture.entries,
      ["counterfeit.json", Buffer.from("{}", "utf8")],
    ]);
    expect(() =>
      exactArtifactFilesFromZip(
        extraFile,
        planFileNames,
        "rollback-plan",
        7_000_000,
      ),
    ).toThrow("unsafe file manifest");

    const traversal = artifactZip(
      fixture.entries.map(([name, bytes], index) => [
        index === 0 ? "../deployment-baseline.json" : name,
        bytes,
      ]),
    );
    expect(() =>
      exactArtifactFilesFromZip(
        traversal,
        planFileNames,
        "rollback-plan",
        7_000_000,
      ),
    ).toThrow("unsafe file manifest");
  });

  test("bounds GitHub artifact redirects by status, declared size, and streamed size", async () => {
    let response = new Response(Buffer.from("archive", "utf8"), {
      status: 200,
      headers: { "content-length": "7" },
    });
    let requestedUrl = "";
    let requestedRedirect = "";
    const api = new GitHubApi({
      token: "test-token",
      repository,
      fetchImpl: async (url: string | URL | Request, options?: RequestInit) => {
        requestedUrl = String(url);
        requestedRedirect = String(options?.redirect);
        return response;
      },
    });
    await expect(api.downloadArtifact("700", 7)).resolves.toEqual(
      Buffer.from("archive", "utf8"),
    );
    expect(requestedUrl).toEndWith("/actions/artifacts/700/zip");
    expect(requestedRedirect).toBe("follow");

    response = new Response(Buffer.from("x", "utf8"), {
      status: 410,
    });
    await expect(api.downloadArtifact("700", 7)).rejects.toThrow("(HTTP 410)");

    response = new Response(Buffer.from("x", "utf8"), {
      status: 200,
      headers: { "content-length": "8" },
    });
    await expect(api.downloadArtifact("700", 7)).rejects.toThrow("size bound");

    response = new Response(Buffer.from("too-large", "utf8"), {
      status: 200,
    });
    await expect(api.downloadArtifact("700", 7)).rejects.toThrow("size bound");
  });

  test("attests exact rollback-plan archive bytes and rejects metadata substitutions", async () => {
    const fixture = planArtifactFixture();
    const source = {
      repository,
      environment: "staging",
      sourceSha,
      sourceRunId: "42",
      sourceRunAttempt: "1",
    };
    const authority = {
      planArtifactName: "gateway-webhook-rollback-plan-staging-42-1",
      planArtifactId: "700",
      planArtifactDigest: fixture.archiveDigest,
    };
    const artifact = {
      id: 700,
      name: authority.planArtifactName,
      digest: `sha256:${fixture.archiveDigest}`,
      expired: false,
      expires_at: "2999-01-01T00:00:00Z",
      size_in_bytes: fixture.archiveBytes.length,
      workflow_run: { id: 42, head_sha: sourceSha },
    };
    const apiFor = (
      artifactOverrides: Record<string, unknown> = {},
      archiveBytes = fixture.archiveBytes,
    ) => ({
      request: async () => ({ ...artifact, ...artifactOverrides }),
      downloadArtifact: async () => archiveBytes,
    });

    await expect(
      attestRollbackPlanArtifact(apiFor(), source, authority),
    ).resolves.toMatchObject({ plaintextSha256: fixture.plaintextDigest });

    for (const overrides of [
      { id: 701 },
      { name: "gateway-webhook-rollback-plan-staging-42-2" },
      { workflow_run: { id: 43, head_sha: sourceSha } },
      { workflow_run: { id: 42, head_sha: "f".repeat(40) } },
      { expired: true },
      { expires_at: "2000-01-01T00:00:00Z" },
      { digest: `sha256:${"f".repeat(64)}` },
      { size_in_bytes: fixture.archiveBytes.length + 1 },
    ]) {
      await expect(
        attestRollbackPlanArtifact(apiFor(overrides), source, authority),
      ).rejects.toThrow(/rollback-plan artifact/);
    }

    const changedArchive = Buffer.from(fixture.archiveBytes);
    changedArchive[35] ^= 1;
    await expect(
      attestRollbackPlanArtifact(apiFor({}, changedArchive), source, authority),
    ).rejects.toThrow("size and digest");
  });

  test("refuses to encrypt local rollback-plan bytes swapped after artifact publication", async () => {
    const fixture = planArtifactFixture();
    const root = mkdtempSync(join(tmpdir(), "gateway-journal-swap-"));
    const source = {
      repository,
      environment: "staging",
      sourceSha,
      sourceRunId: "42",
      sourceRunAttempt: "1",
    };
    const api = {
      request: async () => ({
        id: 700,
        name: "gateway-webhook-rollback-plan-staging-42-1",
        digest: `sha256:${fixture.archiveDigest}`,
        expired: false,
        expires_at: "2999-01-01T00:00:00Z",
        size_in_bytes: fixture.archiveBytes.length,
        workflow_run: { id: 42, head_sha: sourceSha },
      }),
      downloadArtifact: async () => fixture.archiveBytes,
    };
    try {
      for (const [name, bytes] of fixture.entries) {
        writeFileSync(join(root, name), bytes);
      }
      const authoritativeBundle = await attestRollbackPlanArtifact(
        api,
        source,
        {
          planArtifactName: "gateway-webhook-rollback-plan-staging-42-1",
          planArtifactId: "700",
          planArtifactDigest: fixture.archiveDigest,
        },
      );
      await expect(
        publishEncryptedPlan(
          { request: async () => null },
          source,
          root,
          authKey,
          undefined,
        ),
      ).rejects.toThrow("authoritative artifact");
      writeFileSync(join(root, "deployment-baseline.json"), "[]\n");
      await expect(
        publishEncryptedPlan(
          { request: async () => null },
          source,
          root,
          authKey,
          authoritativeBundle,
        ),
      ).rejects.toThrow("local rollback-plan bytes differ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists the intent candidate only as a source-bound authenticated envelope", () => {
    const candidateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const expectedMessage = `gateway-webhook ${sourceSha} (staging) run:42:1 nonce:${"9".repeat(32)}`;
    const source = {
      repository,
      environment: "staging",
      sourceSha,
      sourceRunId: "42",
      sourceRunAttempt: "1",
    };
    const open = { ...openMarker(), commentId: "1" };
    const binding = encryptCandidateEnvelope(
      candidateId,
      expectedMessage,
      source,
      open,
      authKey,
    );
    expect(JSON.stringify(binding)).not.toContain(candidateId);
    expect(
      decryptCandidateEnvelope(binding, expectedMessage, source, open, authKey),
    ).toBe(candidateId);
    expect(() =>
      decryptCandidateEnvelope(
        binding,
        `${expectedMessage}0`,
        source,
        open,
        authKey,
      ),
    ).toThrow("candidate message");
  });

  test("keeps a HMAC checkpoint valid without Actions run or step history", async () => {
    const api = trustedApi([openMarker(), closeMarker()]);
    const state = await readJournalState(api, repository, "staging", authKey);
    expect(state.status).toBe("clear");
    expect(
      api.calls.some((endpoint) => endpoint.includes("/actions/runs/")),
    ).toBe(false);
  });

  test("rekeys only through a clear checkpoint without rereading the old CLOSE", async () => {
    const api = trustedApi([openMarker(), closeMarker()]);
    const previousPayload = recordFromComment(api.comments[1]);
    const previous = {
      ...previousPayload,
      recordId: "2",
      recordSha256: journalRecordDigest(previousPayload),
      createdAt: api.comments[1].created_at,
    };
    const nextAuthKey = "next-protected-journal-auth-key-".repeat(2);
    const checkpointWriter = {
      event: "schedule",
      path: ".github/workflows/recover-gateway-webhook-transactions.yml",
      ref: "refs/heads/develop",
      runAttempt: "1",
      runId: "123",
      sha: "9".repeat(40),
    };
    const unresolved = trustedApi([openMarker()]);
    const unresolvedPayload = recordFromComment(unresolved.comments[0]);
    expect(() =>
      journalCheckpointPayload(
        repository,
        "staging",
        {
          ...unresolvedPayload,
          recordId: "1",
          recordSha256: journalRecordDigest(unresolvedPayload),
          createdAt: unresolved.comments[0].created_at,
        },
        checkpointWriter,
        authKey,
        nextAuthKey,
        "2",
      ),
    ).toThrow("checkpoint inputs");
    const payload = journalCheckpointPayload(
      repository,
      "staging",
      previous,
      checkpointWriter,
      authKey,
      nextAuthKey,
      "3",
    );
    api.comments.push({
      id: 3,
      body: journalRecordCommentBody(payload),
      created_at: "2026-09-03T00:00:03Z",
      updated_at: "2026-09-03T00:00:03Z",
      user: { login: "github-actions[bot]", type: "Bot" },
    });
    const state = await readJournalState(
      api,
      repository,
      "staging",
      nextAuthKey,
    );
    expect(state.status).toBe("clear");
    expect(state.latestRecord.recordId).toBe(payload.logicalRecordId);
    expect(state.latestRecord.physicalCommentIds).toEqual(["3"]);
    expect(state.latestRecord.recordSha256).toBe(
      journalRecordDigest(recordFromComment(api.comments[2])),
    );
    expect(api.calls).not.toContain("/issues/comments/2");
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("superseded");
  });

  test("appends a non-genesis dual-auth checkpoint through the rekey command", async () => {
    const api = trustedApi([openMarker(), closeMarker()]);
    const nextAuthKey = "next-protected-journal-auth-key-".repeat(2);
    const workflowSha = "9".repeat(40);
    const originalRequest = api.request;
    let postCalls = 0;
    api.request = async (
      method: string,
      endpoint: string,
      value?: Record<string, unknown>,
    ) => {
      if (
        endpoint.startsWith(
          "/actions/workflows/deploy-gateway-webhook.yml/runs?",
        )
      ) {
        return { total_count: 0, workflow_runs: [] };
      }
      if (endpoint === "/actions/runs/123/attempts/1") {
        return {
          id: 123,
          run_attempt: 1,
          head_sha: workflowSha,
          head_branch: "develop",
          head_repository: { full_name: repository },
          path: ".github/workflows/recover-gateway-webhook-transactions.yml",
          event: "schedule",
          status: "in_progress",
        };
      }
      if (endpoint === "/branches/develop") {
        return { name: "develop", commit: { sha: workflowSha } };
      }
      if (method === "POST" && endpoint === "/issues/29763/comments") {
        postCalls += 1;
        const createdAt = `2026-09-03T00:00:0${api.comments.length}Z`;
        const created = {
          id: api.comments.length + 1,
          body: value?.body,
          created_at: createdAt,
          updated_at: createdAt,
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        api.comments.push(created);
        return created;
      }
      return originalRequest(method, endpoint);
    };
    const environment = {
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "token",
      GATEWAY_JOURNAL_AUTH_KEY: authKey,
      GATEWAY_JOURNAL_NEXT_AUTH_KEY: nextAuthKey,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: workflowSha,
    };

    const result = await journalMain(
      ["rekey", "--environment", "staging"],
      environment,
      { api },
    );
    expect(result).toMatchObject({
      status: "clear",
      deferred: false,
      checkpointRequired: true,
    });
    expect(postCalls).toBe(1);
    await expect(
      readJournalState(api, repository, "staging", nextAuthKey),
    ).resolves.toMatchObject({
      status: "clear",
      latestRecord: { recordId: result.checkpointRecordId },
    });
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("superseded");

    const repeated = await journalMain(
      ["rekey", "--environment", "staging"],
      environment,
      { api },
    );
    expect(repeated.checkpointRecordId).toBe(result.checkpointRecordId);
    expect(postCalls).toBe(1);

    const checkpointState = await readJournalState(
      api,
      repository,
      "staging",
      nextAuthKey,
    );
    const nextOpen = openMarker({
      sourceSha: "f".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "1",
      planArtifactName: "gateway-webhook-rollback-plan-staging-43-1",
      planArtifactId: "702",
      planArtifactDigest: "2".repeat(64),
    });
    const nextOpenRecord = journalRecordPayload(
      nextOpen,
      checkpointState.latestRecord,
      writerFor(nextOpen),
      nextAuthKey,
    );
    await appendJournalRecord(
      api,
      repository,
      "staging",
      nextOpenRecord,
      nextAuthKey,
    );
    const resumed = await journalMain(
      ["rekey", "--environment", "staging"],
      environment,
      { api },
    );
    expect(resumed).toMatchObject({
      status: "open",
      checkpointRecordId: result.checkpointRecordId,
    });
    expect(postCalls).toBe(2);
  });

  test("does not POST rekey after authority advances during the adjacent previous-head scan", async () => {
    for (const advance of ["run", "develop"] as const) {
      const api = trustedApi([openMarker(), closeMarker()]);
      const nextAuthKey = "next-protected-journal-auth-key-".repeat(2);
      const workflowSha = "9".repeat(40);
      const advancedSha = "8".repeat(40);
      const originalRequest = api.request;
      let journalCommentReads = 0;
      let authorityAdvanced = false;
      let postCalls = 0;
      api.request = async (
        method: string,
        endpoint: string,
        value?: Record<string, unknown>,
      ) => {
        if (
          endpoint.startsWith(
            "/actions/workflows/deploy-gateway-webhook.yml/runs?",
          )
        ) {
          return { total_count: 0, workflow_runs: [] };
        }
        if (endpoint === "/actions/runs/123/attempts/1") {
          return {
            id: 123,
            run_attempt: 1,
            head_sha:
              authorityAdvanced && advance === "run"
                ? advancedSha
                : workflowSha,
            head_branch: "develop",
            head_repository: { full_name: repository },
            path: ".github/workflows/recover-gateway-webhook-transactions.yml",
            event: "schedule",
            status: "in_progress",
          };
        }
        if (endpoint === "/branches/develop") {
          return {
            name: "develop",
            commit: {
              sha:
                authorityAdvanced && advance === "develop"
                  ? advancedSha
                  : workflowSha,
            },
          };
        }
        if (endpoint.startsWith("/issues/29763/comments?")) {
          const response = await originalRequest(method, endpoint);
          journalCommentReads += 1;
          if (journalCommentReads === 10) authorityAdvanced = true;
          return response;
        }
        if (method === "POST" && endpoint === "/issues/29763/comments") {
          postCalls += 1;
          const createdAt = `2026-09-03T00:00:0${api.comments.length}Z`;
          const created = {
            id: api.comments.length + 1,
            body: value?.body,
            created_at: createdAt,
            updated_at: createdAt,
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          api.comments.push(created);
          return created;
        }
        return originalRequest(method, endpoint);
      };

      await expect(
        journalMain(
          ["rekey", "--environment", "staging"],
          {
            GITHUB_REPOSITORY: repository,
            GITHUB_TOKEN: "token",
            GATEWAY_JOURNAL_AUTH_KEY: authKey,
            GATEWAY_JOURNAL_NEXT_AUTH_KEY: nextAuthKey,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_SHA: workflowSha,
          },
          { api },
        ),
      ).rejects.toThrow(
        advance === "run"
          ? "protected recovery authority"
          : "current develop head",
      );
      expect(journalCommentReads).toBe(10);
      expect(authorityAdvanced).toBe(true);
      expect(postCalls).toBe(0);
    }
  });

  test("rejects a rekey when the old head advances or previous authenticator is forged", async () => {
    const api = trustedApi([openMarker(), closeMarker()]);
    const previousPayload = recordFromComment(api.comments[1]);
    const previous = {
      ...previousPayload,
      recordId: previousPayload.logicalRecordId,
      commentId: "2",
      recordSha256: journalRecordDigest(previousPayload),
      createdAt: api.comments[1].created_at,
    };
    const nextAuthKey = "next-protected-journal-auth-key-".repeat(2);
    const checkpointWriter = {
      event: "schedule",
      path: ".github/workflows/recover-gateway-webhook-transactions.yml",
      ref: "refs/heads/develop",
      runAttempt: "1",
      runId: "123",
      sha: "9".repeat(40),
    };
    const checkpoint = journalCheckpointPayload(
      repository,
      "staging",
      previous,
      checkpointWriter,
      authKey,
      nextAuthKey,
    );
    const originalRequest = api.request;
    let postCalls = 0;
    api.request = async (
      method: string,
      endpoint: string,
      value?: Record<string, unknown>,
    ) => {
      if (method === "POST") {
        postCalls += 1;
        throw new Error(`unexpected POST ${String(value?.body)}`);
      }
      return originalRequest(method, endpoint);
    };
    await expect(
      appendJournalRecord(api, repository, "staging", checkpoint, nextAuthKey, {
        previousAuthKey: authKey,
        beforePost: async () => {
          const marker = openMarker({
            sourceRunId: "43",
            sourceRunAttempt: "1",
            sourceSha: "f".repeat(40),
            planArtifactName: "gateway-webhook-rollback-plan-staging-43-1",
            planArtifactId: "702",
            planArtifactDigest: "2".repeat(64),
            previousCloseCommentId: previous.logicalRecordId,
            previousCloseMarkerSha256: markerDigest({
              ...previousPayload.marker,
              commentId: previous.logicalRecordId,
            }),
          });
          const record = journalRecordPayload(
            marker,
            previous,
            writerFor(marker),
            authKey,
          );
          api.comments.push({
            id: 3,
            body: journalRecordCommentBody(record),
            created_at: "2026-09-03T00:00:03Z",
            updated_at: "2026-09-03T00:00:03Z",
            user: { login: "github-actions[bot]", type: "Bot" },
          });
        },
      }),
    ).rejects.toThrow("previous-key head advanced");
    expect(postCalls).toBe(0);

    const forgedApi = trustedApi([openMarker(), closeMarker()]);
    const forgedPreviousPayload = recordFromComment(forgedApi.comments[1]);
    const forgedPrevious = {
      ...forgedPreviousPayload,
      recordId: forgedPreviousPayload.logicalRecordId,
      recordSha256: journalRecordDigest(forgedPreviousPayload),
      createdAt: forgedApi.comments[1].created_at,
    };
    const forged = resignWithCurrentKey(
      {
        ...journalCheckpointPayload(
          repository,
          "staging",
          forgedPrevious,
          checkpointWriter,
          authKey,
          nextAuthKey,
        ),
        previousAuth: "0".repeat(64),
      },
      nextAuthKey,
    );
    forgedApi.comments.push({
      id: 3,
      body: journalRecordCommentBody(forged),
      created_at: "2026-09-03T00:00:03Z",
      updated_at: "2026-09-03T00:00:03Z",
      user: { login: "github-actions[bot]", type: "Bot" },
    });
    await expect(
      journalMain(
        ["rekey", "--environment", "staging"],
        {
          GITHUB_REPOSITORY: repository,
          GITHUB_TOKEN: "token",
          GATEWAY_JOURNAL_AUTH_KEY: authKey,
          GATEWAY_JOURNAL_NEXT_AUTH_KEY: nextAuthKey,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "9".repeat(40),
        },
        { api: forgedApi },
      ),
    ).rejects.toThrow(/previous key|previous-key|authenticated rotation/);
  });

  test("writes a dual-auth genesis checkpoint so an empty-ledger rotation fences the old key", async () => {
    const nextAuthKey = "next-protected-journal-auth-key-".repeat(2);
    const checkpointWriter = {
      event: "schedule",
      path: ".github/workflows/recover-gateway-webhook-transactions.yml",
      ref: "refs/heads/develop",
      runAttempt: "1",
      runId: "123",
      sha: "9".repeat(40),
    };
    const checkpoint = journalCheckpointPayload(
      repository,
      "staging",
      null,
      checkpointWriter,
      authKey,
      nextAuthKey,
      "1",
    );
    const value = {
      id: 1,
      body: journalRecordCommentBody(checkpoint),
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
      user: { login: "github-actions[bot]", type: "Bot" },
    };
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (endpoint.startsWith("/issues/29763/comments?")) return [value];
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    await expect(
      readJournalState(api, repository, "staging", nextAuthKey),
    ).resolves.toMatchObject({ status: "clear" });
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("superseded");
  });

  test("rejects an intent attributed to an unauthorized workflow even with a valid HMAC", async () => {
    const intent = intentMarker();
    const api = trustedApi([openMarker(), intent]);
    const previousPayload = recordFromComment(api.comments[0]);
    const previous = {
      ...previousPayload,
      recordId: previousPayload.logicalRecordId,
      commentId: "1",
      recordSha256: journalRecordDigest(previousPayload),
      createdAt: api.comments[0].created_at,
    };
    intent.openCommentId = previousPayload.logicalRecordId;
    const forgedWriter = {
      ...writerFor(intent),
      path: ".github/workflows/unrelated.yml",
    };
    api.comments[1].body = journalRecordCommentBody(
      journalRecordPayload(intent, previous, forgedWriter, authKey, "2"),
    );
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("exact workflow authority");
  });

  test("reserves the durable journal for staging until main recovery is authorized", async () => {
    const api = trustedApi([]);
    await expect(
      readJournalState(api, repository, "production", authKey),
    ).rejects.toThrow(/BLOCKED on #29488|exact main recovery authority/);
  });

  test("binds OPEN authority to the current source process and exact attempt endpoint", async () => {
    const marker = openMarker();
    const run = {
      id: 42,
      run_attempt: 1,
      head_sha: sourceSha,
      head_branch: "develop",
      head_repository: { full_name: repository },
      path: ".github/workflows/deploy-gateway-webhook.yml",
      event: "workflow_dispatch",
    };
    const api = {
      request: async (_method: string, endpoint: string) => {
        expect(endpoint).toBe("/actions/runs/42/attempts/1");
        return run;
      },
    };
    const runtime = {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: sourceSha,
      GITHUB_REF: "refs/heads/develop",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-gateway-webhook.yml@refs/heads/develop`,
    };
    await expect(
      validateSourceAttempt(api, marker, runtime),
    ).resolves.toMatchObject({
      runId: "42",
      runAttempt: "1",
    });
    await expect(
      validateSourceAttempt(api, marker, { ...runtime, GITHUB_RUN_ID: "999" }),
    ).rejects.toThrow("not owned by the current source process");
  });

  test("reads the real Actions jobs envelope for the exact current reconciliation step", async () => {
    const expectedName =
      "recover-staging / Reconcile Railway candidate (staging)";
    const api = {
      request: async (_method: string, endpoint: string) => {
        expect(endpoint).toContain(
          "/actions/runs/99/attempts/2/jobs?filter=all&per_page=100&page=1",
        );
        return {
          total_count: 1,
          jobs: [
            {
              id: 900,
              name: expectedName,
              status: "in_progress",
              steps: [
                {
                  name: "Close durable gateway transaction",
                  status: "in_progress",
                  conclusion: null,
                },
              ],
            },
          ],
        };
      },
    };
    await expect(
      currentRecoveryJob(
        api,
        "staging",
        "42",
        "1",
        "99",
        "2",
        "Close durable gateway transaction",
      ),
    ).resolves.toEqual({ id: "900", name: expectedName });
  });

  test("rejects every automatic journal mutation after develop advances", async () => {
    for (const authority of [
      {
        path: ".github/workflows/recover-gateway-webhook-transactions.yml",
        event: "schedule",
      },
      {
        path: ".github/workflows/deploy-gateway-webhook.yml",
        event: "workflow_dispatch",
      },
    ]) {
      const endpoints: string[] = [];
      const api = {
        request: async (_method: string, endpoint: string) => {
          endpoints.push(endpoint);
          if (endpoint === "/actions/runs/99/attempts/2") {
            return {
              id: 99,
              run_attempt: 2,
              head_sha: recoverySha,
              head_branch: "develop",
              head_repository: { full_name: repository },
              path: authority.path,
              event: authority.event,
              status: "in_progress",
            };
          }
          if (endpoint === "/branches/develop") {
            return { name: "develop", commit: { sha: "c".repeat(40) } };
          }
          throw new Error(`unexpected endpoint ${endpoint}`);
        },
      };
      await expect(
        validateCurrentRecoveryAttempt(api, intentMarker()),
      ).rejects.toThrow("current develop head");
      expect(endpoints).toEqual([
        "/actions/runs/99/attempts/2",
        "/branches/develop",
      ]);
    }
  });

  test("does not POST a logical marker when its adjacent authority recheck fails", async () => {
    const marker = openMarker();
    const record = journalRecordPayload(
      marker,
      null,
      writerFor(marker),
      authKey,
    );
    let postCalls = 0;
    const api = {
      request: async (method: string, endpoint: string) => {
        if (method === "POST") postCalls += 1;
        if (endpoint.startsWith("/issues/29763/comments?")) return [];
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    await expect(
      appendJournalRecord(api, repository, "staging", record, authKey, {
        beforePost: async () => {
          throw new Error("develop advanced before marker POST");
        },
      }),
    ).rejects.toThrow("develop advanced before marker POST");
    expect(postCalls).toBe(0);
  });

  test("finds an authenticated head beyond one page of unauthenticated lookalikes", async () => {
    const [head] = recordCommentChain([openMarker()]);
    const spam = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
      body: `${RECORD_PREFIX}not-canonical${index}\n-->`,
      created_at: `2026-09-04T00:${String(59 - Math.floor(index / 2)).padStart(2, "0")}:${String(index % 2).padStart(2, "0")}Z`,
      updated_at: `2026-09-04T00:${String(59 - Math.floor(index / 2)).padStart(2, "0")}:${String(index % 2).padStart(2, "0")}Z`,
      user: { login: "attacker", type: "User" },
    }));
    const api = {
      request: async (_method: string, endpoint: string) => {
        const page = Number(
          new URL(`https://example.invalid${endpoint}`).searchParams.get(
            "page",
          ),
        );
        if (page === 1) return spam;
        if (page === 2) return [head];
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).resolves.toMatchObject({ status: "open" });
  });

  test("keeps a descendant OPEN when a lower physical-id alias of its logical CLOSE appears later", async () => {
    const firstClose = closeMarker();
    const secondOpen = openMarker({
      sourceSha: "f".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "2",
      planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
      planArtifactId: "702",
      planArtifactDigest: "2".repeat(64),
      previousCloseCommentId: "2",
      previousCloseMarkerSha256: markerDigest({
        ...firstClose,
        commentId: "2",
      }),
    });
    const api = trustedApi([openMarker(), firstClose, secondOpen]);
    api.comments[1].id = 20;
    api.comments[2].id = 30;
    api.comments.push({
      ...api.comments[1],
      id: 2,
      created_at: "2026-09-03T00:00:01Z",
      updated_at: "2026-09-03T00:00:01Z",
    });
    const replayState = await readJournalState(
      api,
      repository,
      "staging",
      authKey,
    );
    expect(replayState).toMatchObject({
      status: "open",
      open: { sourceRunId: "43", sourceRunAttempt: "2" },
    });
  });

  test("does not hide the latest staging OPEN when its sealed record is edited into a foreign key or namespace", async () => {
    const secondOpen = openMarker({
      sourceSha: "f".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "2",
      planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
      planArtifactId: "702",
      planArtifactDigest: "2".repeat(64),
      previousCloseCommentId: "2",
      previousCloseMarkerSha256: markerDigest({
        ...closeMarker(),
        commentId: "2",
      }),
    });
    for (const edit of [
      { authKeyId: "0".repeat(64), auth: "1".repeat(64) },
      { environment: "production" },
    ]) {
      const api = trustedApi([openMarker(), closeMarker(), secondOpen]);
      const edited = recordFromComment(api.comments[2]);
      Object.assign(edited, edit);
      api.comments[2].body = journalRecordCommentBody(edited);
      await expect(
        readJournalState(api, repository, "staging", authKey),
      ).rejects.toThrow(/foreign-key record|foreign namespace/);
    }
  });

  test("sorts ascending multi-page API results before validating the signed chain", async () => {
    const open = openMarker();
    const openPayload = journalRecordPayload(
      open,
      null,
      writerFor(open),
      authKey,
      "101",
    );
    const previous = {
      ...openPayload,
      recordId: openPayload.logicalRecordId,
      commentId: "101",
      recordSha256: journalRecordDigest(openPayload),
      createdAt: "2026-09-03T00:00:01Z",
    };
    const close = closeMarker({ openCommentId: openPayload.logicalRecordId });
    const closePayload = journalRecordPayload(
      close,
      previous,
      writerFor(close),
      authKey,
      "102",
    );
    const records = [
      {
        id: 101,
        body: journalRecordCommentBody(openPayload),
        created_at: previous.createdAt,
        updated_at: previous.createdAt,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
      {
        id: 102,
        body: journalRecordCommentBody(closePayload),
        created_at: "2026-09-03T00:00:02Z",
        updated_at: "2026-09-03T00:00:02Z",
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    ];
    const oldSpam = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `old human comment ${index}`,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      user: { login: "attacker", type: "User" },
    }));
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (endpoint.startsWith("/issues/29763/comments?")) {
          const page = Number(
            new URL(`https://example.invalid${endpoint}`).searchParams.get(
              "page",
            ),
          );
          return page === 1 ? oldSpam : page === 2 ? records : [];
        }
        const exact = endpoint.match(/^\/issues\/comments\/(\d+)$/);
        if (exact)
          return records.find((value) => value.id === Number(exact[1]));
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).resolves.toMatchObject({ status: "clear" });
  });

  test("rescans offset pages when unrelated deletion shifts an OPEN across the boundary", async () => {
    const initialRecords = recordCommentChain([openMarker(), closeMarker()]);
    const canonicalClose = recordFromComment(initialRecords[1])
      .marker as Record<string, unknown>;
    const records = recordCommentChain([
      openMarker(),
      closeMarker(),
      openMarker({
        sourceSha: "f".repeat(40),
        sourceRunId: "43",
        sourceRunAttempt: "2",
        planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
        planArtifactId: "702",
        planArtifactDigest: "2".repeat(64),
        previousCloseCommentId: "2",
        previousCloseMarkerSha256: markerDigest({
          ...canonicalClose,
          commentId: "2",
        }),
      }),
    ]);
    const spam = Array.from({ length: 100 }, (_, index) => ({
      id: 100 + index,
      body: `unrelated ${index}`,
      created_at: "2026-09-04T00:00:00Z",
      updated_at: "2026-09-04T00:00:00Z",
      user: { login: "attacker", type: "User" },
    }));
    let scan = 0;
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (endpoint.startsWith("/issues/29763/comments?")) {
          const page = Number(
            new URL(`https://example.invalid${endpoint}`).searchParams.get(
              "page",
            ),
          );
          if (page === 1) {
            scan += 1;
            return scan === 1 ? spam : [...spam.slice(1), records[2]];
          }
          if (page === 2) return [records[0], records[1]];
          return [];
        }
        const exact = endpoint.match(/^\/issues\/comments\/(\d+)$/);
        if (exact)
          return records.find((value) => value.id === Number(exact[1]));
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    let state;
    try {
      state = await readJournalState(api, repository, "staging", authKey);
    } catch (error) {
      throw new Error(`stable rescan failed: ${String(error)}`);
    }
    expect(state).toMatchObject({
      status: "open",
      open: { sourceRunId: "43", sourceRunAttempt: "2" },
    });
    expect(scan).toBe(3);
  });

  test("fails closed when complete issue-comment scans never stabilize", async () => {
    let scan = 0;
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (!endpoint.startsWith("/issues/29763/comments?")) {
          throw new Error(`unexpected endpoint ${endpoint}`);
        }
        scan += 1;
        return [
          {
            id: scan,
            body: `moving comment ${scan}`,
            created_at: "2026-09-04T00:00:00Z",
            updated_at: "2026-09-04T00:00:00Z",
            user: { login: "attacker", type: "User" },
          },
        ];
      },
    };
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow("did not stabilize across complete scans");
  });

  test("refuses a sealed append when another signed record interleaves", async () => {
    const open = openMarker();
    const openPayload = journalRecordPayload(
      open,
      null,
      writerFor(open),
      authKey,
      "1",
    );
    const previous = {
      ...openPayload,
      recordId: openPayload.logicalRecordId,
      commentId: "1",
      recordSha256: journalRecordDigest(openPayload),
      createdAt: "2026-09-03T00:00:00Z",
    };
    const forkMarker = intentMarker({
      openCommentId: openPayload.logicalRecordId,
    });
    const forkPayload = journalRecordPayload(
      forkMarker,
      previous,
      writerFor(forkMarker),
      authKey,
      "2",
    );
    const requested = journalRecordPayload(
      closeMarker({ openCommentId: openPayload.logicalRecordId }),
      previous,
      writerFor(closeMarker()),
      authKey,
    );
    const now = Date.now();
    const comments = [
      {
        id: 1,
        body: journalRecordCommentBody(openPayload),
        created_at: previous.createdAt,
        updated_at: previous.createdAt,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    ];
    const api = {
      request: async (
        method: string,
        endpoint: string,
        payload?: { body?: string },
      ) => {
        if (method === "POST") {
          comments.push({
            id: 2,
            body: journalRecordCommentBody(forkPayload),
            created_at: new Date(now - 1_000).toISOString(),
            updated_at: new Date(now - 1_000).toISOString(),
            user: { login: "github-actions[bot]", type: "Bot" },
          });
          const requestedComment = {
            id: 3,
            body: payload?.body ?? "",
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          comments.push(requestedComment);
          return requestedComment;
        }
        const exact = endpoint.match(/^\/issues\/comments\/(\d+)$/);
        if (method === "GET" && exact) {
          return comments.find(
            (commentValue) => commentValue.id === Number(exact[1]),
          );
        }
        if (endpoint.startsWith("/issues/29763/comments?")) return comments;
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    await expect(
      appendJournalRecord(api, repository, "staging", requested, authKey),
    ).rejects.toThrow(/distinct logical siblings|canonical logical head/);
  });

  test("does not let a later transaction mask a tampered CLOSE checkpoint", async () => {
    const firstClose = {
      ...closeMarker(),
      result: "candidate-proven",
    };
    const secondOpen = openMarker({
      sourceSha: "f".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "2",
      planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
      planArtifactId: "702",
      planArtifactDigest: "2".repeat(64),
      previousCloseCommentId: "2",
      previousCloseMarkerSha256: markerDigest({
        ...firstClose,
        commentId: "2",
      }),
    });
    const secondClose = closeMarker({
      sourceSha: "f".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "2",
      openCommentId: "3",
      recoveryRunId: "100",
      recoveryRunAttempt: "3",
      recoveryJobId: "901",
      recoveryJobName:
        "recover-staging / Reconcile Railway candidate (staging)",
      recoveryWorkflowSha: "1".repeat(40),
      resolutionArtifactName:
        "gateway-webhook-reconciliation-staging-43-2-100-3",
      resolutionArtifactId: "703",
      resolutionArtifactDigest: "3".repeat(64),
      resolutionReceiptSha256: "4".repeat(64),
    });
    const api = trustedApi([openMarker(), firstClose, secondOpen, secondClose]);
    const tampered = recordFromComment(api.comments[1]);
    tampered.marker.result = "prior-snapshot-preserved";
    api.comments[1].body = journalRecordCommentBody(tampered);
    await expect(
      readJournalState(api, repository, "staging", authKey),
    ).rejects.toThrow(
      /claims the protected key but fails authentication|digest/,
    );
  });

  test("reconciles a lost POST acknowledgement by exact canonical body", async () => {
    const createdAt = new Date().toISOString();
    const exact = comment(177, openMarker(), {
      created_at: createdAt,
      updated_at: createdAt,
    });
    const api = {
      request: async (method: string, endpoint: string) => {
        if (method === "POST") throw new Error("connection reset after accept");
        if (endpoint.startsWith("/issues/29763/comments?")) {
          const page = Number(
            new URL(`https://example.invalid${endpoint}`).searchParams.get(
              "page",
            ),
          );
          if (page === 1) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              body: `old comment ${index}`,
              created_at: "2026-09-01T00:00:00Z",
              updated_at: "2026-09-01T00:00:00Z",
              user: { login: "attacker", type: "User" },
            }));
          }
          if (page === 2) return [exact];
          return [];
        }
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    await expect(postAndReadBack(api, exact.body)).resolves.toMatchObject({
      commentId: "177",
      kind: "open",
    });
  });

  test("collapses a lost-ack v2 logical write into authenticated aliases", async () => {
    const marker = openMarker();
    const payload = journalRecordPayload(
      marker,
      null,
      writerFor(marker),
      authKey,
    );
    const body = journalRecordCommentBody(payload);
    const createdAt = new Date().toISOString();
    const aliases: Record<string, unknown>[] = [];
    let nextId = 700;
    const api = {
      request: async (method: string, endpoint: string, value?: any) => {
        if (method === "POST") {
          aliases.push({
            id: nextId++,
            body: value.body,
            created_at: createdAt,
            updated_at: createdAt,
            user: { login: "github-actions[bot]", type: "Bot" },
          });
          throw new Error("connection reset after accepted comment");
        }
        if (endpoint.startsWith("/issues/29763/comments?")) return aliases;
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    await expect(
      appendJournalRecord(api, repository, "staging", payload, authKey),
    ).resolves.toMatchObject({ logicalRecordId: payload.logicalRecordId });
    expect(aliases).toHaveLength(1);
    expect(aliases[0].body).toBe(body);
  });

  test("collapses the same semantic rollback intent across fresh recovery runs without replay", async () => {
    const open = openMarker();
    const [openComment] = recordCommentChain([open]);
    const openRecord = recordFromComment(openComment);
    const openNode = {
      ...openRecord,
      recordSha256: journalRecordDigest(openRecord),
    };
    const firstMarker = intentMarker({
      openCommentId: openRecord.logicalRecordId,
    });
    const firstRecord = journalRecordPayload(
      firstMarker,
      openNode,
      writerFor(firstMarker),
      authKey,
    );
    const retryMarker = {
      ...firstMarker,
      recoveryRunId: "100",
      recoveryRunAttempt: "3",
      recoveryJobId: "901",
      recoveryWorkflowSha: "d".repeat(40),
    };
    const retryRecord = journalRecordPayload(
      retryMarker,
      openNode,
      writerFor(retryMarker),
      authKey,
    );
    expect(retryRecord.logicalRecordId).toBe(firstRecord.logicalRecordId);
    expect(markerDigest(retryMarker)).toBe(markerDigest(firstMarker));
    const createdAt = "2026-09-03T00:00:01Z";
    const comments = [
      openComment,
      {
        id: 2,
        body: journalRecordCommentBody(firstRecord),
        created_at: createdAt,
        updated_at: createdAt,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
      {
        id: 3,
        body: journalRecordCommentBody(retryRecord),
        created_at: "2026-09-03T00:00:02Z",
        updated_at: "2026-09-03T00:00:02Z",
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    ];
    let postCalls = 0;
    const api = {
      request: async (method: string, endpoint: string) => {
        if (method === "POST") postCalls += 1;
        if (endpoint.startsWith("/issues/29763/comments?")) return comments;
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    const semanticState = await readJournalState(
      api,
      repository,
      "staging",
      authKey,
    );
    expect(semanticState).toMatchObject({
      status: "open",
      rollbackIntents: [{ commentId: firstRecord.logicalRecordId }],
    });
    await expect(
      appendJournalRecord(api, repository, "staging", retryRecord, authKey),
    ).resolves.toMatchObject({
      logicalRecordId: firstRecord.logicalRecordId,
      newlyPublished: false,
    });
    expect(postCalls).toBe(0);
  });

  test("rejects distinct CLOSE resolution proofs as conflicting siblings", async () => {
    const [openComment] = recordCommentChain([openMarker()]);
    const openRecord = recordFromComment(openComment);
    const openNode = {
      ...openRecord,
      recordSha256: journalRecordDigest(openRecord),
    };
    const firstMarker = closeMarker({
      openCommentId: openRecord.logicalRecordId,
    });
    const firstRecord = journalRecordPayload(
      firstMarker,
      openNode,
      writerFor(firstMarker),
      authKey,
    );
    const proofVariants = [
      {
        recoveryRunId: "100",
        recoveryRunAttempt: "3",
        recoveryJobId: "901",
        recoveryWorkflowSha: "f".repeat(40),
        resolutionArtifactName:
          "gateway-webhook-reconciliation-staging-42-1-100-3",
      },
      { resolutionArtifactId: "702" },
      { resolutionArtifactDigest: "1".repeat(64) },
      { resolutionReceiptSha256: "2".repeat(64) },
    ];
    for (const proofOverride of proofVariants) {
      const differentProofMarker = closeMarker({
        ...firstMarker,
        ...proofOverride,
      });
      const differentProofRecord = journalRecordPayload(
        differentProofMarker,
        openNode,
        writerFor(differentProofMarker),
        authKey,
      );
      expect(differentProofRecord.logicalRecordId).not.toBe(
        firstRecord.logicalRecordId,
      );
      expect(markerDigest(differentProofMarker)).not.toBe(
        markerDigest(firstMarker),
      );

      const comments = [
        openComment,
        {
          id: 2,
          body: journalRecordCommentBody(firstRecord),
          created_at: "2026-09-03T00:00:01Z",
          updated_at: "2026-09-03T00:00:01Z",
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 3,
          body: journalRecordCommentBody(differentProofRecord),
          created_at: "2026-09-03T00:00:02Z",
          updated_at: "2026-09-03T00:00:02Z",
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ];
      const api = {
        request: async (method: string, endpoint: string) => {
          if (
            method === "GET" &&
            endpoint.startsWith("/issues/29763/comments?")
          )
            return comments;
          throw new Error(`unexpected ${method} ${endpoint}`);
        },
      };
      await expect(
        readJournalState(api, repository, "staging", authKey),
      ).rejects.toThrow("distinct logical siblings");
    }
  });

  test("does not authorize a replay when an older intent alias appears after retry POST", async () => {
    const [openComment] = recordCommentChain([openMarker()]);
    const rawOpen = recordFromComment(openComment);
    const openNode = {
      ...rawOpen,
      recordSha256: journalRecordDigest(rawOpen),
    };
    const originalMarker = intentMarker({
      openCommentId: rawOpen.logicalRecordId,
    });
    const original = journalRecordPayload(
      originalMarker,
      openNode,
      writerFor(originalMarker),
      authKey,
    );
    const retryMarker = {
      ...originalMarker,
      recoveryRunId: "100",
      recoveryRunAttempt: "3",
      recoveryJobId: "901",
      recoveryWorkflowSha: "d".repeat(40),
    };
    const retry = journalRecordPayload(
      retryMarker,
      openNode,
      writerFor(retryMarker),
      authKey,
    );
    const recordComment = (
      id: number,
      record: Record<string, unknown>,
      createdAt: string,
    ) => ({
      id,
      body: journalRecordCommentBody(record),
      created_at: createdAt,
      updated_at: createdAt,
      user: { login: "github-actions[bot]", type: "Bot" },
    });
    const prior = recordComment(2, original, "2026-09-03T00:00:01Z");
    const current = recordComment(3, retry, "2026-09-03T00:00:02Z");
    let scans = 0;
    const api = {
      request: async (method: string, endpoint: string) => {
        if (method === "POST") return current;
        if (endpoint.startsWith("/issues/29763/comments?")) {
          scans += 1;
          return scans <= 2 ? [openComment] : [openComment, prior, current];
        }
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
    };
    await expect(
      appendJournalRecord(api, repository, "staging", retry, authKey),
    ).resolves.toMatchObject({
      logicalRecordId: retry.logicalRecordId,
      newlyPublished: false,
    });
  });

  test("commits the exact prepared logical OPEN after its immutable artifact is durable", async () => {
    const planFixture = planArtifactFixture();
    const marker = openMarker({
      planArtifactDigest: planFixture.archiveDigest,
      journalPlanPlaintextSha256: planFixture.plaintextDigest,
    });
    const record = journalRecordPayload(
      marker,
      null,
      writerFor(marker),
      authKey,
    );
    const descriptor = preparedOpenDescriptor(record);
    const descriptorBytes = Buffer.from(
      `${JSON.stringify(canonicalForAuthentication(descriptor))}\n`,
      "utf8",
    );
    const descriptorArchive = artifactZip([
      ["gateway-webhook-prepared-open.json", descriptorBytes],
    ]);
    const comments: Record<string, any>[] = [];
    const artifactDigest = sha256(descriptorArchive);
    let planDownloads = 0;
    let preparedOpenDownloads = 0;
    const api = {
      request: async (method: string, endpoint: string, value?: any) => {
        if (endpoint === "/actions/artifacts/811") {
          return {
            id: 811,
            name: descriptor.artifactName,
            digest: `sha256:${artifactDigest}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            size_in_bytes: descriptorArchive.length,
            workflow_run: { id: 42, head_sha: sourceSha },
          };
        }
        if (endpoint === "/actions/artifacts/700") {
          return {
            id: 700,
            name: marker.planArtifactName,
            digest: `sha256:${planFixture.archiveDigest}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            size_in_bytes: planFixture.archiveBytes.length,
            workflow_run: { id: 42, head_sha: sourceSha },
          };
        }
        if (endpoint === "/actions/runs/42/attempts/1") {
          return {
            id: 42,
            run_attempt: 1,
            head_sha: sourceSha,
            head_branch: "develop",
            head_repository: { full_name: repository },
            path: ".github/workflows/deploy-gateway-webhook.yml",
            event: "workflow_dispatch",
          };
        }
        if (endpoint === "/branches/develop") {
          return { name: "develop", commit: { sha: sourceSha } };
        }
        if (method === "POST" && endpoint === "/issues/29763/comments") {
          const createdAt = new Date().toISOString();
          const created = {
            id: 901,
            body: value.body,
            created_at: createdAt,
            updated_at: createdAt,
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          comments.push(created);
          return created;
        }
        if (endpoint.startsWith("/issues/29763/comments?")) return comments;
        throw new Error(`unexpected ${method} ${endpoint}`);
      },
      downloadArtifact: async (artifactId: string) => {
        if (artifactId === "811") {
          preparedOpenDownloads += 1;
          return descriptorArchive;
        }
        if (artifactId === "700") {
          planDownloads += 1;
          return planFixture.archiveBytes;
        }
        throw new Error(`unexpected artifact ${artifactId}`);
      },
    };
    const committed = await commitPreparedOpen(
      api,
      descriptor,
      {
        artifactId: "811",
        artifactName: descriptor.artifactName,
        artifactDigest,
      },
      authKey,
      {
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: sourceSha,
        GITHUB_REF: "refs/heads/develop",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-gateway-webhook.yml@refs/heads/develop`,
      },
    );
    expect(committed.commentId).toBe(record.logicalRecordId);
    expect(comments).toHaveLength(1);
    expect(planDownloads).toBe(2);
    expect(preparedOpenDownloads).toBe(2);
  });

  test("authenticates the exact prepared OPEN archive, descriptor, and source attempt", async () => {
    const marker = openMarker();
    const descriptor = preparedOpenDescriptor(
      journalRecordPayload(marker, null, writerFor(marker), authKey),
    );
    const canonicalDescriptorBytes = Buffer.from(
      `${JSON.stringify(canonicalForAuthentication(descriptor))}\n`,
      "utf8",
    );
    const canonicalArchive = artifactZip([
      ["gateway-webhook-prepared-open.json", canonicalDescriptorBytes],
    ]);
    const validRun = {
      id: 42,
      run_attempt: 1,
      head_sha: sourceSha,
      head_branch: "develop",
      head_repository: { full_name: repository },
      path: ".github/workflows/deploy-gateway-webhook.yml",
      event: "workflow_dispatch",
    };
    const apiFor = ({
      archive = canonicalArchive,
      artifactArchive = archive,
      artifactOverrides = {},
      runOverrides = {},
    }: {
      archive?: Buffer;
      artifactArchive?: Buffer;
      artifactOverrides?: Record<string, unknown>;
      runOverrides?: Record<string, unknown>;
    } = {}) => {
      const digest = sha256(archive);
      return {
        authority: {
          artifactId: "811",
          artifactName: descriptor.artifactName,
          artifactDigest: digest,
        },
        api: {
          request: async (_method: string, endpoint: string) => {
            if (endpoint === "/actions/artifacts/811") {
              return {
                id: 811,
                name: descriptor.artifactName,
                digest: `sha256:${digest}`,
                expired: false,
                expires_at: "2999-01-01T00:00:00Z",
                size_in_bytes: archive.length,
                workflow_run: { id: 42, head_sha: sourceSha },
                ...artifactOverrides,
              };
            }
            if (endpoint === "/actions/runs/42/attempts/1") {
              return { ...validRun, ...runOverrides };
            }
            throw new Error(`unexpected endpoint ${endpoint}`);
          },
          downloadArtifact: async () => artifactArchive,
        },
      };
    };

    const valid = apiFor();
    await expect(
      validatePreparedOpenArtifact(valid.api, descriptor, valid.authority),
    ).resolves.toEqual(canonicalDescriptorBytes);

    for (const artifactOverrides of [
      { id: 812 },
      { name: `${descriptor.artifactName}-counterfeit` },
      { expired: true },
      { expires_at: "2000-01-01T00:00:00Z" },
      { workflow_run: { id: 43, head_sha: sourceSha } },
      { workflow_run: { id: 42, head_sha: "b".repeat(40) } },
      { size_in_bytes: 0 },
      { size_in_bytes: Number.MAX_SAFE_INTEGER },
      { digest: `sha256:${"0".repeat(64)}` },
    ]) {
      const fixture = apiFor({ artifactOverrides });
      await expect(
        validatePreparedOpenArtifact(
          fixture.api,
          descriptor,
          fixture.authority,
        ),
      ).rejects.toThrow("prepared OPEN artifact");
    }

    for (const runOverrides of [
      { id: 43 },
      { run_attempt: 2 },
      { head_sha: "b".repeat(40) },
    ]) {
      const fixture = apiFor({ runOverrides });
      await expect(
        validatePreparedOpenArtifact(
          fixture.api,
          descriptor,
          fixture.authority,
        ),
      ).rejects.toThrow("exact source attempt");
    }

    const alternateMarker = openMarker({ planArtifactId: "799" });
    const alternateDescriptor = preparedOpenDescriptor(
      journalRecordPayload(
        alternateMarker,
        null,
        writerFor(alternateMarker),
        authKey,
      ),
    );
    const counterfeitDescriptor = Buffer.from(
      `${JSON.stringify(canonicalForAuthentication(alternateDescriptor))}\n`,
      "utf8",
    );
    for (const archive of [
      artifactZip([
        ["gateway-webhook-prepared-open.json", counterfeitDescriptor],
      ]),
      artifactZip([
        ["gateway-webhook-prepared-open.json", canonicalDescriptorBytes],
        ["extra.json", Buffer.from("{}", "utf8")],
      ]),
      artifactZip([
        ["../gateway-webhook-prepared-open.json", canonicalDescriptorBytes],
      ]),
      artifactZip([
        [
          "gateway-webhook-prepared-open.json",
          Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8"),
        ],
      ]),
    ]) {
      const fixture = apiFor({ archive });
      await expect(
        validatePreparedOpenArtifact(
          fixture.api,
          descriptor,
          fixture.authority,
        ),
      ).rejects.toThrow(/prepared OPEN artifact/);
    }

    const mismatchedArchive = Buffer.from(canonicalArchive);
    mismatchedArchive[mismatchedArchive.length - 1] ^= 1;
    const digestMismatch = apiFor({ artifactArchive: mismatchedArchive });
    await expect(
      validatePreparedOpenArtifact(
        digestMismatch.api,
        descriptor,
        digestMismatch.authority,
      ),
    ).rejects.toThrow("archive does not match its size and digest");
  });

  test("does not POST OPEN when run or develop advances during artifact re-attestation", async () => {
    for (const advance of ["run", "develop"] as const) {
      const planFixture = planArtifactFixture();
      const marker = openMarker({
        planArtifactDigest: planFixture.archiveDigest,
        journalPlanPlaintextSha256: planFixture.plaintextDigest,
      });
      const record = journalRecordPayload(
        marker,
        null,
        writerFor(marker),
        authKey,
      );
      const descriptor = preparedOpenDescriptor(record);
      const descriptorBytes = Buffer.from(
        `${JSON.stringify(canonicalForAuthentication(descriptor))}\n`,
        "utf8",
      );
      const descriptorArchive = artifactZip([
        ["gateway-webhook-prepared-open.json", descriptorBytes],
      ]);
      const descriptorDigest = sha256(descriptorArchive);
      let planDownloads = 0;
      let authorityAdvanced = false;
      let postCalls = 0;
      const api = {
        request: async (method: string, endpoint: string) => {
          if (method === "POST") postCalls += 1;
          if (endpoint.startsWith("/issues/29763/comments?")) return [];
          if (endpoint === "/actions/artifacts/811") {
            return {
              id: 811,
              name: descriptor.artifactName,
              digest: `sha256:${descriptorDigest}`,
              expired: false,
              expires_at: "2999-01-01T00:00:00Z",
              size_in_bytes: descriptorArchive.length,
              workflow_run: { id: 42, head_sha: sourceSha },
            };
          }
          if (endpoint === "/actions/artifacts/700") {
            return {
              id: 700,
              name: marker.planArtifactName,
              digest: `sha256:${planFixture.archiveDigest}`,
              expired: false,
              expires_at: "2999-01-01T00:00:00Z",
              size_in_bytes: planFixture.archiveBytes.length,
              workflow_run: { id: 42, head_sha: sourceSha },
            };
          }
          if (endpoint === "/actions/runs/42/attempts/1") {
            return {
              id: 42,
              run_attempt: 1,
              head_sha:
                authorityAdvanced && advance === "run"
                  ? "b".repeat(40)
                  : sourceSha,
              head_branch: "develop",
              head_repository: { full_name: repository },
              path: ".github/workflows/deploy-gateway-webhook.yml",
              event: "workflow_dispatch",
            };
          }
          if (endpoint === "/branches/develop") {
            return {
              name: "develop",
              commit: {
                sha:
                  authorityAdvanced && advance === "develop"
                    ? "b".repeat(40)
                    : sourceSha,
              },
            };
          }
          throw new Error(`unexpected ${method} ${endpoint}`);
        },
        downloadArtifact: async (artifactId: string) => {
          if (artifactId === "811") return descriptorArchive;
          if (artifactId === "700") {
            planDownloads += 1;
            if (planDownloads === 2) authorityAdvanced = true;
            return planFixture.archiveBytes;
          }
          throw new Error(`unexpected artifact ${artifactId}`);
        },
      };

      await expect(
        commitPreparedOpen(
          api,
          descriptor,
          {
            artifactId: "811",
            artifactName: descriptor.artifactName,
            artifactDigest: descriptorDigest,
          },
          authKey,
          {
            GITHUB_REPOSITORY: repository,
            GITHUB_RUN_ID: "42",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_SHA: sourceSha,
            GITHUB_REF: "refs/heads/develop",
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-gateway-webhook.yml@refs/heads/develop`,
          },
        ),
      ).rejects.toThrow(
        advance === "run" ? "exact source attempt" : "current develop head",
      );
      expect(planDownloads).toBe(2);
      expect(postCalls).toBe(0);
    }
  });

  test("does not POST recovered OPEN when source, rekey, or develop advances during artifact re-attestation", async () => {
    for (const advance of ["source-run", "rekey-run", "develop"] as const) {
      const rekeySha = "9".repeat(40);
      const planFixture = planArtifactFixture();
      const marker = openMarker({
        planArtifactDigest: planFixture.archiveDigest,
        journalPlanPlaintextSha256: planFixture.plaintextDigest,
      });
      const record = journalRecordPayload(
        marker,
        null,
        writerFor(marker),
        authKey,
      );
      const descriptor = preparedOpenDescriptor(record);
      const descriptorBytes = Buffer.from(
        `${JSON.stringify(canonicalForAuthentication(descriptor))}\n`,
        "utf8",
      );
      const descriptorArchive = artifactZip([
        ["gateway-webhook-prepared-open.json", descriptorBytes],
      ]);
      const descriptorDigest = sha256(descriptorArchive);
      let preparedOpenDownloads = 0;
      let planDownloads = 0;
      let authorityAdvanced = false;
      let postCalls = 0;
      const api = {
        request: async (method: string, endpoint: string) => {
          if (method === "POST") postCalls += 1;
          if (endpoint.startsWith("/issues/29763/comments?")) return [];
          if (endpoint === "/actions/artifacts/811") {
            return {
              id: 811,
              name: descriptor.artifactName,
              digest: `sha256:${descriptorDigest}`,
              expired: false,
              expires_at: "2999-01-01T00:00:00Z",
              size_in_bytes: descriptorArchive.length,
              workflow_run: { id: 42, head_sha: sourceSha },
            };
          }
          if (endpoint === "/actions/artifacts/700") {
            return {
              id: 700,
              name: marker.planArtifactName,
              digest: `sha256:${planFixture.archiveDigest}`,
              expired: false,
              expires_at: "2999-01-01T00:00:00Z",
              size_in_bytes: planFixture.archiveBytes.length,
              workflow_run: { id: 42, head_sha: sourceSha },
            };
          }
          if (endpoint === "/actions/runs/42/attempts/1") {
            return {
              id: 42,
              run_attempt: 1,
              head_sha:
                authorityAdvanced && advance === "source-run"
                  ? "b".repeat(40)
                  : sourceSha,
              head_branch: "develop",
              head_repository: { full_name: repository },
              path: ".github/workflows/deploy-gateway-webhook.yml",
              event: "workflow_dispatch",
            };
          }
          if (endpoint === "/actions/runs/123/attempts/1") {
            return {
              id: 123,
              run_attempt: 1,
              head_sha:
                authorityAdvanced && advance === "rekey-run"
                  ? "b".repeat(40)
                  : rekeySha,
              head_branch: "develop",
              head_repository: { full_name: repository },
              path: ".github/workflows/recover-gateway-webhook-transactions.yml",
              event: "schedule",
              status: "in_progress",
            };
          }
          if (endpoint === "/branches/develop") {
            return {
              name: "develop",
              commit: {
                sha:
                  authorityAdvanced && advance === "develop"
                    ? "b".repeat(40)
                    : rekeySha,
              },
            };
          }
          throw new Error(`unexpected ${method} ${endpoint}`);
        },
        downloadArtifact: async (artifactId: string) => {
          if (artifactId === "811") {
            preparedOpenDownloads += 1;
            if (preparedOpenDownloads === 2 && advance === "source-run") {
              authorityAdvanced = true;
            }
            return descriptorArchive;
          }
          if (artifactId === "700") {
            planDownloads += 1;
            if (planDownloads === 2 && advance !== "source-run") {
              authorityAdvanced = true;
            }
            return planFixture.archiveBytes;
          }
          throw new Error(`unexpected artifact ${artifactId}`);
        },
      };

      await expect(
        commitPreparedOpen(
          api,
          descriptor,
          {
            artifactId: "811",
            artifactName: descriptor.artifactName,
            artifactDigest: descriptorDigest,
          },
          authKey,
          {
            GITHUB_REPOSITORY: repository,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_SHA: rekeySha,
          },
        ),
      ).rejects.toThrow(
        advance === "source-run"
          ? "exact source attempt"
          : advance === "rekey-run"
            ? "protected recovery authority"
            : "current develop head",
      );
      expect(preparedOpenDownloads).toBe(2);
      expect(planDownloads).toBe(advance === "source-run" ? 1 : 2);
      expect(postCalls).toBe(0);
    }
  });

  test("discovers an invisible earlier prepared OPEN and refuses a distinct sibling", async () => {
    const first = preparedOpenDescriptor(
      journalRecordPayload(
        openMarker(),
        null,
        writerFor(openMarker()),
        authKey,
      ),
    );
    const secondMarker = openMarker({
      sourceSha: "d".repeat(40),
      sourceRunId: "43",
      sourceRunAttempt: "2",
      planArtifactName: "gateway-webhook-rollback-plan-staging-43-2",
      planArtifactId: "701",
      planArtifactDigest: "e".repeat(64),
    });
    const second = preparedOpenDescriptor(
      journalRecordPayload(
        secondMarker,
        null,
        writerFor(secondMarker),
        authKey,
      ),
    );
    const artifact = (id: number, descriptor: any) => ({
      id,
      name: descriptor.artifactName,
      digest: `sha256:${"f".repeat(64)}`,
      expired: false,
      workflow_run: { id: Number(descriptor.sourceRunId) },
    });
    const artifacts = [artifact(801, first)];
    const api = {
      request: async (_method: string, endpoint: string) => {
        expect(endpoint.startsWith("/actions/artifacts?")).toBe(false);
        if (
          endpoint.startsWith(
            "/actions/workflows/deploy-gateway-webhook.yml/runs?",
          )
        ) {
          return {
            total_count: 2,
            workflow_runs: [
              {
                id: 42,
                head_branch: "develop",
                event: "workflow_dispatch",
                status: "in_progress",
              },
              {
                id: 43,
                head_branch: "develop",
                event: "workflow_dispatch",
                status: "queued",
              },
            ],
          };
        }
        if (endpoint.startsWith("/actions/runs/42/artifacts?")) {
          const values = artifacts.filter(
            (value) => value.workflow_run.id === 42,
          );
          return { total_count: values.length, artifacts: values };
        }
        if (endpoint.startsWith("/actions/runs/43/artifacts?")) {
          const values = artifacts.filter(
            (value) => value.workflow_run.id === 43,
          );
          return { total_count: values.length, artifacts: values };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    const clear = {
      status: "clear",
      logicalRecordIds: [],
    };
    await expect(findPreparedOpenArtifact(api, clear)).resolves.toMatchObject({
      logicalRecordId: first.logicalRecordId,
      sourceRunId: "42",
    });
    artifacts.push(artifact(802, second));
    await expect(findPreparedOpenArtifact(api, clear)).rejects.toThrow(
      "multiple unresolved prepared OPEN artifacts",
    );
  });

  test("bounds prepared-OPEN artifact reads while retaining recent successful and queued runs", async () => {
    const resumedMarker = openMarker({
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      planArtifactName: "gateway-webhook-rollback-plan-staging-9001-1",
      planArtifactId: "7001",
      planArtifactDigest: "e".repeat(64),
    });
    const descriptor = preparedOpenDescriptor(
      journalRecordPayload(
        resumedMarker,
        null,
        writerFor(resumedMarker),
        authKey,
      ),
    );
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
    const recent = new Date().toISOString();
    const oldSuccesses = Array.from({ length: 205 }, (_, index) => ({
      id: 10_000 + index,
      head_branch: "develop",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      updated_at: old,
      completed_at: old,
    }));
    const runs = [
      ...oldSuccesses,
      {
        id: 9001,
        head_branch: "develop",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        created_at: old,
        updated_at: recent,
        completed_at: recent,
      },
      {
        id: 9002,
        head_branch: "develop",
        event: "workflow_dispatch",
        status: "queued",
        conclusion: null,
        created_at: old,
      },
      {
        id: 9003,
        head_branch: "develop",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "failure",
        updated_at: old,
        completed_at: old,
      },
    ];
    const artifactCalls: number[] = [];
    const api = {
      request: async (_method: string, endpoint: string) => {
        if (
          endpoint.startsWith(
            "/actions/workflows/deploy-gateway-webhook.yml/runs?",
          )
        ) {
          const page = Number(
            new URL(`https://example.invalid${endpoint}`).searchParams.get(
              "page",
            ),
          );
          const start = (page - 1) * 100;
          return {
            total_count: runs.length,
            workflow_runs: runs.slice(start, start + 100),
          };
        }
        const match = endpoint.match(/^\/actions\/runs\/(\d+)\/artifacts\?/);
        if (match) {
          const runId = Number(match[1]);
          artifactCalls.push(runId);
          if (runId === 9001) {
            return {
              total_count: 1,
              artifacts: [
                {
                  id: 8001,
                  name: descriptor.artifactName,
                  digest: `sha256:${"f".repeat(64)}`,
                  expired: false,
                  workflow_run: { id: 9001 },
                },
              ],
            };
          }
          return { total_count: 0, artifacts: [] };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    await expect(
      findPreparedOpenArtifact(api, { status: "clear", logicalRecordIds: [] }),
    ).resolves.toMatchObject({ sourceRunId: "9001" });
    expect(artifactCalls.sort()).toEqual([9001, 9001, 9002, 9002]);
  });

  test("fails before exceeding the shared prepared-OPEN discovery request budget", async () => {
    const runs = Array.from({ length: 399 }, (_, index) => ({
      id: 20_000 + index,
      head_branch: "develop",
      event: "workflow_dispatch",
      status: "queued",
      conclusion: null,
    }));
    let requests = 0;
    const api = {
      request: async (_method: string, endpoint: string) => {
        requests += 1;
        if (
          endpoint.startsWith(
            "/actions/workflows/deploy-gateway-webhook.yml/runs?",
          )
        ) {
          const page = Number(
            new URL(`https://example.invalid${endpoint}`).searchParams.get(
              "page",
            ),
          );
          const start = (page - 1) * 100;
          return {
            total_count: runs.length,
            workflow_runs: runs.slice(start, start + 100),
          };
        }
        if (/^\/actions\/runs\/\d+\/artifacts\?/.test(endpoint)) {
          return { total_count: 0, artifacts: [] };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
    await expect(
      findPreparedOpenArtifact(api, { status: "clear", logicalRecordIds: [] }),
    ).rejects.toThrow("400-request budget");
    expect(requests).toBe(400);
  });

  test("fails closed on overlapping OPEN and an unsequenced convergence intent", () => {
    const open = openMarker();
    expect(() =>
      reduceJournal(
        [comment(1, open), comment(2, open)],
        repository,
        "staging",
      ),
    ).toThrow("overlapping OPEN");
    const intent = intentMarker();
    expect(() =>
      reduceJournal(
        [comment(1, open), comment(2, intent), comment(3, intent)],
        repository,
        "staging",
      ),
    ).toThrow("bounded linear sequence");
  });

  test("permits exactly R1 then R2 after a signed terminal-negative observation", () => {
    const open = openMarker();
    const firstIntent = intentMarker();
    const firstObservation = observationMarker({
      status: "FAILED",
      intentMarkerSha256: markerDigest({ ...firstIntent, commentId: "2" }),
    });
    const secondIntent = intentMarker({
      ordinal: 2,
      previousIntentCommentId: "2",
      previousIntentMarkerSha256: markerDigest({
        ...firstIntent,
        commentId: "2",
      }),
      failedRestorationIdSha256: firstObservation.restorationIdSha256,
    });
    const secondObservation = observationMarker({
      ordinal: 2,
      intentCommentId: "4",
      intentMarkerSha256: markerDigest({ ...secondIntent, commentId: "4" }),
      restorationIdSha256: "6".repeat(64),
    });
    const close = closeMarker({
      result: "prior-snapshot-restored",
      rollbackIntentCount: 2,
      lastRollbackIntentCommentId: "4",
      lastRollbackIntentMarkerSha256: markerDigest({
        ...secondIntent,
        commentId: "4",
      }),
      rollbackObservationCount: 2,
      lastRollbackObservationCommentId: "5",
      lastRollbackObservationMarkerSha256: markerDigest({
        ...secondObservation,
        commentId: "5",
      }),
    });
    expect(
      reduceJournal(
        [
          comment(1, open),
          comment(2, firstIntent),
          comment(3, firstObservation),
          comment(4, secondIntent),
          comment(5, secondObservation),
          comment(6, close),
        ],
        repository,
        "staging",
      ).status,
    ).toBe("clear");

    expect(() =>
      reduceJournal(
        [
          comment(1, open),
          comment(2, firstIntent),
          comment(3, firstObservation),
          comment(4, secondIntent),
          comment(5, secondObservation),
          comment(6, intentMarker({ ordinal: 3 })),
        ],
        repository,
        "staging",
      ),
    ).toThrow();
  });

  test("binds the restored CLOSE to one signed ready restoration observation", () => {
    const open = openMarker();
    const intent = intentMarker();
    const observation = observationMarker({
      intentMarkerSha256: markerDigest({ ...intent, commentId: "2" }),
      status: "SLEEPING",
    });
    const close = closeMarker({
      result: "prior-snapshot-restored",
      rollbackIntentCount: 1,
      lastRollbackIntentCommentId: "2",
      lastRollbackIntentMarkerSha256: markerDigest({
        ...intent,
        commentId: "2",
      }),
      rollbackObservationCount: 1,
      lastRollbackObservationCommentId: "3",
      lastRollbackObservationMarkerSha256: markerDigest({
        ...observation,
        commentId: "3",
      }),
    });
    expect(
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(3, observation),
          comment(4, close),
        ],
        repository,
        "staging",
      ).status,
    ).toBe("clear");

    expect(() =>
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(3, observationMarker({ intentMarkerSha256: "0".repeat(64) })),
        ],
        repository,
        "staging",
      ),
    ).toThrow("does not bind or uniquely refine its intent");
  });

  test("refines one ambiguous observation exactly once without another intent", () => {
    const open = openMarker();
    const intent = intentMarker();
    const ambiguous = observationMarker({
      intentMarkerSha256: markerDigest({ ...intent, commentId: "2" }),
      restorationIdSha256: null,
      status: "AMBIGUOUS",
    });
    const refinement = observationMarker({
      intentMarkerSha256: markerDigest({ ...intent, commentId: "2" }),
      refinesObservationCommentId: "3",
      refinesObservationMarkerSha256: markerDigest({
        ...ambiguous,
        commentId: "3",
      }),
      restorationIdSha256: "6".repeat(64),
      status: "SUCCESS",
    });
    const close = closeMarker({
      result: "prior-snapshot-restored",
      rollbackIntentCount: 1,
      lastRollbackIntentCommentId: "2",
      lastRollbackIntentMarkerSha256: markerDigest({
        ...intent,
        commentId: "2",
      }),
      rollbackObservationCount: 1,
      lastRollbackObservationCommentId: "4",
      lastRollbackObservationMarkerSha256: markerDigest({
        ...refinement,
        commentId: "4",
      }),
    });
    const refined = reduceJournal(
      [
        comment(1, open),
        comment(2, intent),
        comment(3, ambiguous),
        comment(4, refinement),
      ],
      repository,
      "staging",
    );
    expect(refined.rollbackObservations).toHaveLength(1);
    expect(refined.rollbackObservations[0].status).toBe("SUCCESS");
    expect(
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(3, ambiguous),
          comment(4, refinement),
          comment(5, close),
        ],
        repository,
        "staging",
      ).status,
    ).toBe("clear");
    expect(() =>
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(3, ambiguous),
          comment(4, refinement),
          comment(5, {
            ...refinement,
            refinesObservationCommentId: "4",
            refinesObservationMarkerSha256: markerDigest({
              ...refinement,
              commentId: "4",
            }),
          }),
        ],
        repository,
        "staging",
      ),
    ).toThrow("uniquely refine");
  });

  test("closes a sole prior snapshot after an ambiguous unissued intent", () => {
    const open = openMarker();
    const intent = intentMarker();
    const observation = observationMarker({
      intentMarkerSha256: markerDigest({ ...intent, commentId: "2" }),
      restorationIdSha256: null,
      status: "AMBIGUOUS",
    });
    const close = closeMarker({
      result: "prior-snapshot-preserved",
      rollbackIntentCount: 1,
      lastRollbackIntentCommentId: "2",
      lastRollbackIntentMarkerSha256: markerDigest({
        ...intent,
        commentId: "2",
      }),
      rollbackObservationCount: 1,
      lastRollbackObservationCommentId: "3",
      lastRollbackObservationMarkerSha256: markerDigest({
        ...observation,
        commentId: "3",
      }),
    });
    expect(
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(3, observation),
          comment(4, close),
        ],
        repository,
        "staging",
      ).status,
    ).toBe("clear");

    expect(() =>
      reduceJournal(
        [
          comment(1, open),
          comment(2, intent),
          comment(
            3,
            observationMarker({
              intentMarkerSha256: markerDigest({ ...intent, commentId: "2" }),
            }),
          ),
          comment(4, close),
        ],
        repository,
        "staging",
      ),
    ).toThrow("CLOSE does not bind");
  });

  test("binds CLOSE to the exact downloaded receipt and rejects swapped local bytes", async () => {
    const runClose = async (swapLocalReceipt: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "gateway-journal-close-"));
      const receiptPath = join(root, "gateway-webhook-reconciliation.json");
      const api = trustedApi([openMarker()]);
      const openRecord = recordFromComment(api.comments[0]);
      const candidateDeploymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const receipt = {
        version: 1,
        result: "candidate-proven",
        repository,
        environment: "staging",
        sourceSha,
        workflowRunId: "42",
        workflowRunAttempt: "1",
        openCommentId: openRecord.logicalRecordId,
        recoveryWorkflowRunId: "99",
        recoveryWorkflowRunAttempt: "2",
        rollbackPlanArtifactId: "700",
        rollbackPlanArtifactDigest: "c".repeat(64),
        rollbackAttempts: [],
        priorSnapshotId: "snapshot_prior_123",
        candidateDeploymentId,
        observedActiveDeploymentId: candidateDeploymentId,
        observedActiveSnapshotId: "snapshot_candidate_123",
      };
      const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
      const archiveBytes = artifactZip([
        ["gateway-webhook-reconciliation.json", receiptBytes],
      ]);
      const archiveDigest = sha256(archiveBytes);
      writeFileSync(
        receiptPath,
        swapLocalReceipt
          ? JSON.stringify({
              ...receipt,
              candidateDeploymentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            })
          : receiptBytes,
      );
      const originalRequest = api.request;
      let downloads = 0;
      api.request = async (
        method: string,
        endpoint: string,
        value?: { body?: string },
      ) => {
        if (endpoint.startsWith("/actions/runs/99/attempts/2/jobs?")) {
          return {
            total_count: 1,
            jobs: [
              {
                id: 900,
                name: "recover-staging / Reconcile Railway candidate (staging)",
                status: "in_progress",
                steps: [
                  {
                    name: "Close durable gateway transaction",
                    status: "in_progress",
                    conclusion: null,
                  },
                ],
              },
            ],
          };
        }
        if (endpoint === "/actions/runs/99/attempts/2") {
          return {
            id: 99,
            run_attempt: 2,
            head_sha: recoverySha,
            head_branch: "develop",
            head_repository: { full_name: repository },
            path: ".github/workflows/recover-gateway-webhook-transactions.yml",
            event: "schedule",
            status: "in_progress",
          };
        }
        if (endpoint === "/branches/develop") {
          return { name: "develop", commit: { sha: recoverySha } };
        }
        if (endpoint === "/actions/artifacts/701") {
          return {
            id: 701,
            name: "gateway-webhook-reconciliation-staging-42-1-99-2",
            digest: `sha256:${archiveDigest}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            size_in_bytes: archiveBytes.length,
            workflow_run: { id: 99, head_sha: recoverySha },
          };
        }
        if (method === "POST" && endpoint === "/issues/29763/comments") {
          const created = {
            id: api.comments.length + 1,
            body: value?.body,
            created_at: "2026-09-03T00:00:03Z",
            updated_at: "2026-09-03T00:00:03Z",
            user: { login: "github-actions[bot]", type: "Bot" },
          };
          api.comments.push(created);
          return created;
        }
        return originalRequest(method, endpoint);
      };
      Object.assign(api, {
        downloadArtifact: async () => {
          downloads += 1;
          return archiveBytes;
        },
      });
      try {
        const operation = journalMain(
          [
            "close",
            "--environment",
            "staging",
            "--source-sha",
            sourceSha,
            "--source-run-id",
            "42",
            "--source-run-attempt",
            "1",
            "--resolution-artifact-name",
            "gateway-webhook-reconciliation-staging-42-1-99-2",
            "--resolution-artifact-id",
            "701",
            "--resolution-artifact-digest",
            archiveDigest,
            "--resolution-receipt-path",
            receiptPath,
            "--result",
            "candidate-proven",
          ],
          {
            GITHUB_REPOSITORY: repository,
            GITHUB_TOKEN: "token",
            GATEWAY_JOURNAL_AUTH_KEY: authKey,
            GITHUB_RUN_ID: "99",
            GITHUB_RUN_ATTEMPT: "2",
            GITHUB_SHA: recoverySha,
          },
          { api },
        );
        if (swapLocalReceipt) {
          await expect(operation).rejects.toThrow(
            "local resolution receipt differs",
          );
          expect(downloads).toBe(1);
          return null;
        }
        const result = await operation;
        expect(result).toMatchObject({
          kind: "close",
          result: "candidate-proven",
          resolutionReceiptSha256: sha256(receiptBytes),
        });
        expect(downloads).toBe(2);
        return result;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    await expect(runClose(false)).resolves.toMatchObject({ kind: "close" });
    await expect(runClose(true)).resolves.toBeNull();
  });

  test("does not POST CLOSE when run or develop advances during receipt re-attestation", async () => {
    for (const advance of ["run", "develop"] as const) {
      const root = mkdtempSync(join(tmpdir(), "gateway-journal-close-race-"));
      const receiptPath = join(root, "gateway-webhook-reconciliation.json");
      const api = trustedApi([openMarker()]);
      const openRecord = recordFromComment(api.comments[0]);
      const candidateDeploymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const receipt = {
        version: 1,
        result: "candidate-proven",
        repository,
        environment: "staging",
        sourceSha,
        workflowRunId: "42",
        workflowRunAttempt: "1",
        openCommentId: openRecord.logicalRecordId,
        recoveryWorkflowRunId: "99",
        recoveryWorkflowRunAttempt: "2",
        rollbackPlanArtifactId: "700",
        rollbackPlanArtifactDigest: "c".repeat(64),
        rollbackAttempts: [],
        priorSnapshotId: "snapshot_prior_123",
        candidateDeploymentId,
        observedActiveDeploymentId: candidateDeploymentId,
        observedActiveSnapshotId: "snapshot_candidate_123",
      };
      const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
      const archiveBytes = artifactZip([
        ["gateway-webhook-reconciliation.json", receiptBytes],
      ]);
      const archiveDigest = sha256(archiveBytes);
      writeFileSync(receiptPath, receiptBytes);
      const originalRequest = api.request;
      let downloads = 0;
      let authorityAdvanced = false;
      let postCalls = 0;
      api.request = async (
        method: string,
        endpoint: string,
        value?: { body?: string },
      ) => {
        if (method === "POST") postCalls += 1;
        if (endpoint.startsWith("/actions/runs/99/attempts/2/jobs?")) {
          return {
            total_count: 1,
            jobs: [
              {
                id: 900,
                name: "recover-staging / Reconcile Railway candidate (staging)",
                status: "in_progress",
                steps: [
                  {
                    name: "Close durable gateway transaction",
                    status: "in_progress",
                    conclusion: null,
                  },
                ],
              },
            ],
          };
        }
        if (endpoint === "/actions/runs/99/attempts/2") {
          return {
            id: 99,
            run_attempt: 2,
            head_sha:
              authorityAdvanced && advance === "run"
                ? "c".repeat(40)
                : recoverySha,
            head_branch: "develop",
            head_repository: { full_name: repository },
            path: ".github/workflows/recover-gateway-webhook-transactions.yml",
            event: "schedule",
            status: "in_progress",
          };
        }
        if (endpoint === "/branches/develop") {
          return {
            name: "develop",
            commit: {
              sha:
                authorityAdvanced && advance === "develop"
                  ? "c".repeat(40)
                  : recoverySha,
            },
          };
        }
        if (endpoint === "/actions/artifacts/701") {
          return {
            id: 701,
            name: "gateway-webhook-reconciliation-staging-42-1-99-2",
            digest: `sha256:${archiveDigest}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            size_in_bytes: archiveBytes.length,
            workflow_run: { id: 99, head_sha: recoverySha },
          };
        }
        return originalRequest(method, endpoint, value);
      };
      Object.assign(api, {
        downloadArtifact: async () => {
          downloads += 1;
          if (downloads === 2) authorityAdvanced = true;
          return archiveBytes;
        },
      });
      try {
        await expect(
          journalMain(
            [
              "close",
              "--environment",
              "staging",
              "--source-sha",
              sourceSha,
              "--source-run-id",
              "42",
              "--source-run-attempt",
              "1",
              "--resolution-artifact-name",
              "gateway-webhook-reconciliation-staging-42-1-99-2",
              "--resolution-artifact-id",
              "701",
              "--resolution-artifact-digest",
              archiveDigest,
              "--resolution-receipt-path",
              receiptPath,
              "--result",
              "candidate-proven",
            ],
            {
              GITHUB_REPOSITORY: repository,
              GITHUB_TOKEN: "token",
              GATEWAY_JOURNAL_AUTH_KEY: authKey,
              GITHUB_RUN_ID: "99",
              GITHUB_RUN_ATTEMPT: "2",
              GITHUB_SHA: recoverySha,
            },
            { api },
          ),
        ).rejects.toThrow(
          advance === "run"
            ? "protected recovery attempt"
            : "current develop head",
        );
        expect(downloads).toBe(2);
        expect(postCalls).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects counterfeit resolution artifact authority", async () => {
    const receiptBytes = Buffer.from("{}", "utf8");
    const archiveBytes = artifactZip([
      ["gateway-webhook-reconciliation.json", receiptBytes],
    ]);
    const digest = sha256(archiveBytes);
    const marker = closeMarker({
      resolutionArtifactDigest: digest,
    });
    const validArtifact = {
      id: 701,
      name: marker.resolutionArtifactName,
      digest: `sha256:${digest}`,
      expired: false,
      expires_at: "2999-01-01T00:00:00Z",
      size_in_bytes: archiveBytes.length,
      workflow_run: { id: 99, head_sha: recoverySha },
    };
    const apiFor = (overrides: Record<string, unknown>) => ({
      request: async () => ({ ...validArtifact, ...overrides }),
      downloadArtifact: async () => archiveBytes,
    });
    await expect(attestResolutionArtifact(apiFor({}), marker)).resolves.toEqual(
      receiptBytes,
    );
    for (const overrides of [
      { id: 702 },
      { name: "gateway-webhook-reconciliation-staging-42-1-98-2" },
      { workflow_run: { id: 98, head_sha: recoverySha } },
      { workflow_run: { id: 99, head_sha: sourceSha } },
      { expired: true },
      { expires_at: "2000-01-01T00:00:00Z" },
      { digest: `sha256:${"0".repeat(64)}` },
    ]) {
      await expect(
        attestResolutionArtifact(apiFor(overrides), marker),
      ).rejects.toThrow("resolution artifact");
    }
  });
});

describe("Gateway webhook journal Actions annotations", () => {
  test("encodes workflow-command data in the required order", () => {
    expect(encodeWorkflowCommandData("safe%context\r\nnext")).toBe(
      "safe%25context%0D%0Anext",
    );
  });

  test("redacts external exception fields and command-injection payloads", () => {
    const canaries = [
      "fake-secret-journal-canary",
      "123456789-resource-id",
      '{"providerBody":"private"}',
      "first line\r\n::warning::injected-command",
    ];
    const providerError = Object.assign(new Error(canaries.join(" ")), {
      argv: ["provider", "--token", canaries[0]],
      body: canaries[2],
      resourceId: canaries[1],
      stderr: canaries[3],
    });
    let output = "";
    writeRedactedActionFailure(
      { write: (value: string) => (output += value) },
      "gateway-webhook-journal",
      providerError,
    );

    expect(output).toBe(
      "::error::gateway-webhook-journal failure-class=external-dependency-failure\n",
    );
    for (const canary of canaries) expect(output).not.toContain(canary);
    expect(output.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  test("does not carry a GitHub endpoint or HTTP body in the propagated error", async () => {
    const endpointCanary =
      "/actions/artifacts/123456789-endpoint-resource-canary";
    const bodyCanary =
      "fake-secret-http-body%\r\n::error::provider-body-injection";
    const api = new GitHubApi({
      token: "test-token",
      repository,
      fetchImpl: async () => new Response(bodyCanary, { status: 502 }),
    });
    let caught: unknown;
    try {
      await api.request("GET", endpointCanary);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RedactedActionError);
    if (!(caught instanceof RedactedActionError)) {
      throw new Error("expected a classified GitHub API failure");
    }
    expect(caught.message).toBe("GitHub API request failed (HTTP 502)");
    expect(caught.diagnosticClass).toBe("github-api-request-failure");
    const propagated = `${caught.name}\n${caught.message}\n${caught.stack ?? ""}\n${JSON.stringify(caught)}`;
    expect(propagated).not.toContain(endpointCanary);
    expect(propagated).not.toContain(bodyCanary);

    let output = "";
    writeRedactedActionFailure(
      { write: (value: string) => (output += value) },
      "gateway-webhook-journal",
      caught,
    );
    expect(output).toBe(
      "::error::gateway-webhook-journal failure-class=github-api-request-failure\n",
    );
  });

  test("keeps a safe fail-closed class without emitting its raw message", () => {
    const rawMessage =
      "fake-secret-validation\r\n::notice::forged-provider-body";
    let output = "";
    writeRedactedActionFailure(
      { write: (value: string) => (output += value) },
      "gateway-webhook-journal",
      new RedactedActionError(rawMessage),
    );

    expect(output).toBe(
      "::error::gateway-webhook-journal failure-class=fail-closed-validation\n",
    );
    expect(output).not.toContain(rawMessage);
    expect(output).not.toContain("forged-provider-body");
  });
});
