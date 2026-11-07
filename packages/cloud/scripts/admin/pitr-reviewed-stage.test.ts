import { expect, test } from "bun:test";
import { inspectPitrStagePatch } from "./pitr-reviewed-stage";

const allowed = ["WAL_ARCHIVE_BUCKET", "WAL_ARCHIVE_KEY"];
function patch() {
  return {
    services: {
      root: {
        variables: { WAL_ARCHIVE_BUCKET: { value: "private-reference" } },
      },
    },
    buckets: { owned: { name: "private-bucket" } },
  };
}
test("only reviewed WAL scope and owned bucket keys pass structural staging inspection", () => {
  expect(inspectPitrStagePatch(patch(), "root", allowed, ["owned"])).toBe(true);
  for (const extra of [
    { source: { image: "different" } },
    { volumes: {} },
    { deploy: {} },
    {
      variables: {
        PGPASSWORD: { value: "private-secret" },
        WAL_ARCHIVE_BUCKET: { value: "x" },
      },
    },
  ]) {
    const p = patch();
    Object.assign(p.services.root, extra);
    expect(inspectPitrStagePatch(p, "root", allowed, ["owned"])).toBe(false);
  }
  expect(inspectPitrStagePatch(patch(), "root", allowed, [])).toBe(false);
  expect(
    inspectPitrStagePatch({ ...patch(), volumes: {} }, "root", allowed, [
      "owned",
    ]),
  ).toBe(false);
});

import { createHash } from "node:crypto";
import {
  type StageSnapshot,
  type StageTransport,
  stagePitrPolicyEngine,
  stageReviewedPitr,
} from "./pitr-reviewed-stage";

function stageFixture() {
  const serializedTemplate = '{"synthetic":true}';
  const approved = createHash("sha256")
    .update(JSON.stringify(JSON.parse(serializedTemplate)))
    .digest("hex");
  const before: StageSnapshot = {
    binding: {
      projectId: "p",
      environmentId: "e",
      serviceId: "root",
      volumeId: "v",
      imageSha256: "a".repeat(64),
      sourceHead: "b".repeat(40),
      configSha256: "c".repeat(64),
      stagedSha256: "d".repeat(64),
      observedAtMs: 1000,
      standalone: true,
      authorityMatches: true,
      postgresMajor: "18",
      backupReceipt: "e".repeat(64),
      backupCompleted: true,
      backupRetained: true,
      healthy: true,
    },
    bucketIds: [],
    preservedConfigSha256: "f".repeat(64),
    stagedPatch: {},
  };
  const after = { ...before, bucketIds: ["owned"], stagedPatch: patch() };
  let reads = 0,
    stages = 0,
    intents = 0,
    observations = 0;
  const transport: StageTransport = {
    async snapshot() {
      return reads++ ? after : before;
    },
    async persistIntent() {
      intents++;
    },
    async stage() {
      stages++;
      return { workflowId: "private-workflow" };
    },
    async awaitComplete() {
      return true;
    },
    async verifyBucketBinding() {
      return true;
    },
    async persistObservation() {
      observations++;
    },
  };
  return {
    serializedTemplate,
    approved,
    before,
    after,
    review: {
      before,
      serializedTemplateSha256: approved,
      writerMaintenanceReceipt: "1".repeat(64),
      operationReceipt: "2".repeat(64),
      expiresAtMs: 2000,
      allowedVariableNames: allowed,
    },
    transport,
    now: () => 1000,
    counts: () => ({ stages, intents, observations }),
  };
}
test("synthetic stage captures actual private patch but never commits; fixed production wrapper rejects synthetic template", async () => {
  const f = stageFixture();
  expect((await stagePitrPolicyEngine(f, f.approved)).state).toBe(
    "staged_requires_review",
  );
  expect(f.counts()).toEqual({ stages: 1, intents: 1, observations: 1 });
  const g = stageFixture();
  expect((await stageReviewedPitr(g)).state).toBe("refused_before_stage");
  expect(g.counts().stages).toBe(0);
});
test("stage timeout/lost reply never retries and preserves uncertainty; prohibited resulting patch remains retained", async () => {
  const f = stageFixture();
  f.transport.awaitComplete = async () => false;
  expect((await stagePitrPolicyEngine(f, f.approved)).state).toBe(
    "creation_unconfirmed",
  );
  expect(f.counts().stages).toBe(1);
  const g = stageFixture();
  Object.assign(g.after.stagedPatch.services.root, {
    source: { image: "changed" },
  });
  expect((await stagePitrPolicyEngine(g, g.approved)).state).toBe(
    "staged_prohibited_change",
  );
  expect(g.counts().observations).toBe(1);
  const h = stageFixture();
  h.transport.verifyBucketBinding = async () => false;
  expect((await stagePitrPolicyEngine(h, h.approved)).state).toBe(
    "staged_prohibited_change",
  );
});

import { readFileSync } from "node:fs";
import { OBSERVED_TEMPLATE } from "./pitr-reviewed-stage";

test("fixed template binding matches the actual protected receipt and normalized string/object policy", async () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL("./pitr-observed-template-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  expect(OBSERVED_TEMPLATE).toHaveLength(64);
  expect(OBSERVED_TEMPLATE).toBe(receipt.serializedTemplate);
  expect(receipt.runId).toBe(39362671367);
  const f = stageFixture();
  expect(
    (
      await stagePitrPolicyEngine(
        { ...f, serializedTemplate: JSON.parse(f.serializedTemplate) },
        f.approved,
      )
    ).state,
  ).toBe("staged_requires_review");
});

test("stage refuses malformed identity before any resource creation", async () => {
  const f = stageFixture();
  f.before.binding.volumeId = "";
  expect((await stagePitrPolicyEngine(f, f.approved)).state).toBe(
    "refused_before_stage",
  );
  expect(f.counts().stages).toBe(0);
});
