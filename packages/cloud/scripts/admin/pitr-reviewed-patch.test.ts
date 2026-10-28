import { expect, test } from "bun:test";
import {
  commitReviewedPitrPatch,
  type PitrPatchReview,
  type PitrSnapshot,
  pitrPatchReceipt,
} from "./pitr-reviewed-patch";

function fixture() {
  const before: PitrSnapshot = {
    projectId: "private-project",
    environmentId: "private-environment",
    serviceId: "private-service",
    volumeId: "private-volume",
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
  };
  const patch = {
    services: {
      "private-service": {
        variables: {
          WAL_ARCHIVE_BUCKET: { value: "private-bucket-reference" },
        },
      },
    },
  };
  const review: PitrPatchReview = {
    before,
    afterConfigSha256: "f".repeat(64),
    afterStagedSha256: "d".repeat(64),
    patchSha256: pitrPatchReceipt(patch),
    allowedVariableNames: ["WAL_ARCHIVE_BUCKET"],
    ownedBucketIds: [],
    writerMaintenanceReceipt: "1".repeat(64),
    expiresAtMs: 2000,
  };
  let observations = 0;
  const calls: unknown[] = [];
  const transport = {
    async snapshot() {
      return observations++ === 0
        ? { ...before }
        : { ...before, configSha256: review.afterConfigSha256 };
    },
    async commitExactPatch(environmentId: string, submitted: unknown) {
      calls.push({ environmentId, submitted });
      return { data: { environmentPatchCommit: "private-operation" } };
    },
  };
  return { patch, review, transport, calls, now: () => 1000 };
}
test("exact reviewed patch commits once with unchanged resource authority and no readiness claim", async () => {
  const input = fixture();
  const result = await commitReviewedPitrPatch(input);
  expect(result.state).toBe("committed_observed");
  expect(input.calls).toHaveLength(1);
  expect(result.nonAtomicWriterRaceRemains).toBe(true);
  expect(result.productionMigrationReady).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private-");
});
test("expired approval, unrelated changes, missing backup proof or altered scope never mutate", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.review.expiresAtMs = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.expiresAtMs = Number.NaN;
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.before.observedAtMs = Number.NaN;
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.before.configSha256 = "invalid";
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.patchSha256 = "0".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.before.backupCompleted = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.review.before.postgresMajor = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.transport.snapshot = async () => ({
        ...f.review.before,
        stagedSha256: "2".repeat(64),
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.transport.snapshot = async () => ({
        ...f.review.before,
        observedAtMs: -60000,
      });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.patch.services["private-service"], {
        source: { image: "unreviewed" },
      });
      f.review.patchSha256 = pitrPatchReceipt(f.patch);
    },
  ]) {
    const input = fixture();
    mutate(input);
    expect((await commitReviewedPitrPatch(input)).state).toBe(
      "refused_before_mutation",
    );
    expect(input.calls).toHaveLength(0);
  }
});
test("lost commit reply is unconfirmed and never retried or followed by automatic cleanup", async () => {
  const input = fixture();
  input.transport.commitExactPatch = async () => {
    input.calls.push("submitted");
    throw Error("private-token/provider-error");
  };
  const result = await commitReviewedPitrPatch(input);
  expect(result.state).toBe("commit_unconfirmed");
  expect(input.calls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private-");
});
test("caller mutation after approval cannot change the submitted patch; postcommit drift stays explicit", async () => {
  const input = fixture();
  let reads = 0;
  input.transport.snapshot = async () => {
    if (reads++ === 0) {
      input.patch.services[
        "private-service"
      ].variables.WAL_ARCHIVE_BUCKET.value = "unreviewed-race";
      return { ...input.review.before };
    }
    return { ...input.review.before, configSha256: "0".repeat(64) };
  };
  const result = await commitReviewedPitrPatch(input);
  expect(result.state).toBe("post_commit_drift");
  expect(input.calls).toHaveLength(1);
  expect(JSON.stringify(input.calls)).not.toContain("unreviewed-race");
});

test("expected postcommit config from a stale cached observation is refused", async () => {
  const input = fixture();
  let time = 1000;
  input.now = () => time;
  const commit = input.transport.commitExactPatch;
  input.transport.commitExactPatch = async (...args) => {
    const result = await commit(...args);
    time = 1500;
    return result;
  };
  expect((await commitReviewedPitrPatch(input)).state).toBe(
    "post_commit_drift",
  );
  expect(input.calls).toHaveLength(1);
});

test("caller allowlist cannot authorize database credential mutations", async () => {
  const input = fixture();
  Object.assign(input.patch.services["private-service"].variables, {
    PGPASSWORD: { value: "private-secret" },
  });
  input.review.allowedVariableNames = ["WAL_ARCHIVE_BUCKET", "PGPASSWORD"];
  input.review.patchSha256 = pitrPatchReceipt(input.patch);
  expect((await commitReviewedPitrPatch(input)).state).toBe(
    "refused_before_mutation",
  );
  expect(input.calls).toHaveLength(0);
});
