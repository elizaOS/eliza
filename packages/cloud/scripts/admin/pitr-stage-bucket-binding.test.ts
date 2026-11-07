import { expect, test } from "bun:test";
import { observedStageBucketBinding } from "./pitr-stage-bucket-binding";

function fixture() {
  const existing = { id: "old", projectId: "project", name: "existing" };
  return {
    beforeBuckets: { old: existing },
    afterBuckets: {
      old: existing,
      new: { id: "new", projectId: "project", name: "archive" },
    },
    newBucketId: "new",
    projectId: "project",
    serviceId: "db",
    stagedPatch: {
      buckets: { new: { region: "region" } },
      services: {
        db: {
          variables: Object.fromEntries(
            Object.entries({
              WAL_ARCHIVE_BUCKET: "BUCKET",
              WAL_ARCHIVE_ENDPOINT: "ENDPOINT",
              WAL_ARCHIVE_KEY: "ACCESS_KEY_ID",
              WAL_ARCHIVE_SECRET: "SECRET_ACCESS_KEY",
              WAL_ARCHIVE_REGION: "REGION",
            }).map(([name, field]) => [
              name,
              { value: `\${{archive.${field}}}` },
            ]),
          ),
        },
      },
    },
  };
}
test("sole observed new bucket owns every actual WAL reference without resolving secrets", () => {
  expect(observedStageBucketBinding(fixture())).toBe(true);
});
test("wrong bucket, another credential namespace, foreign inventory drift or duplicate name refuses", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.afterBuckets.new.projectId = "foreign";
    },
    (f: ReturnType<typeof fixture>) => {
      f.afterBuckets.old = { ...f.afterBuckets.old, name: "changed" };
    },
    (f: ReturnType<typeof fixture>) => {
      f.afterBuckets.new.name = "existing";
    },
    (f: ReturnType<typeof fixture>) => {
      f.stagedPatch.services.db.variables.WAL_ARCHIVE_SECRET.value = `\${{existing.SECRET_ACCESS_KEY}}`;
    },
    (f: ReturnType<typeof fixture>) => {
      f.stagedPatch.services.db.variables.WAL_ARCHIVE_BUCKET.value =
        "arbitrary-literal";
    },
  ]) {
    const f = fixture();
    change(f);
    expect(observedStageBucketBinding(f)).toBe(false);
  }
});
