// Exercises app db deprovision job service behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  type AppDbDeprovisioner,
  dispatchAppDbDeprovisionJob,
  enqueueAppDbDeprovision,
  getAppDbDeprovisioner,
  readAppDbDeprovisionJobData,
  setAppDbDeprovisioner,
} from "../app-db-deprovision-job-service";
import type { ContainerJobInsert, ContainerJobsWriter } from "../container-job-service";

describe("readAppDbDeprovisionJobData", () => {
  test("extracts appId + dbUri", () => {
    expect(readAppDbDeprovisionJobData({ data: { appId: "app-1", dbUri: "enc:v1:x" } })).toEqual({
      appId: "app-1",
      dbUri: "enc:v1:x",
    });
  });
  test("throws when appId missing/blank", () => {
    expect(() => readAppDbDeprovisionJobData({ data: { dbUri: "x" } })).toThrow(
      /missing data.appId/,
    );
    expect(() => readAppDbDeprovisionJobData({ data: { appId: "", dbUri: "x" } })).toThrow(
      /missing data.appId/,
    );
  });
  test("throws when dbUri missing/blank", () => {
    expect(() => readAppDbDeprovisionJobData({ data: { appId: "a" } })).toThrow(
      /missing data.dbUri/,
    );
    expect(() => readAppDbDeprovisionJobData({ data: { appId: "a", dbUri: "" } })).toThrow(
      /missing data.dbUri/,
    );
  });
});

describe("app db deprovisioner injection", () => {
  test("getAppDbDeprovisioner throws before it is wired", () => {
    expect(() => getAppDbDeprovisioner()).toThrow(/not configured/);
  });

  test("dispatch decrypts the carried URI and delegates to the injected deprovisioner", async () => {
    const calls: Array<{ appId: string; dsn: string }> = [];
    const backend: AppDbDeprovisioner = {
      deprovisionForApp: async (appId, dsn) => {
        calls.push({ appId, dsn });
        return { deprovisioned: true };
      },
    };
    setAppDbDeprovisioner(backend);
    // Plaintext DSN (env-DSN mode): decryptIfNeeded is a passthrough, so the
    // dsn reaches the backend unchanged. (Encrypted mode is covered by
    // field-encryption's own round-trip tests.)
    const out = await dispatchAppDbDeprovisionJob({
      data: { appId: "app-42", dbUri: "postgres://u:p@10.30.1.10:5432/app_42" },
    });
    expect(out).toEqual({ deprovisioned: true });
    expect(calls).toEqual([{ appId: "app-42", dsn: "postgres://u:p@10.30.1.10:5432/app_42" }]);
  });
});

describe("enqueueAppDbDeprovision", () => {
  test("inserts an APP_DB_DEPROVISION job carrying appId + encrypted dbUri (pg-free writer)", async () => {
    const inserted: ContainerJobInsert[] = [];
    const writer: ContainerJobsWriter = {
      insertJob: async (j) => {
        inserted.push(j);
        return { id: "job-1" };
      },
    };
    const r = await enqueueAppDbDeprovision(writer, {
      appId: "app-1",
      organizationId: "org-1",
      userId: "u-1",
      dbUri: "enc:v1:ciphertext",
    });
    expect(r.id).toBe("job-1");
    expect(inserted[0]).toEqual({
      type: "app_db_deprovision",
      organizationId: "org-1",
      userId: "u-1",
      data: { appId: "app-1", dbUri: "enc:v1:ciphertext" },
    });
  });
});
