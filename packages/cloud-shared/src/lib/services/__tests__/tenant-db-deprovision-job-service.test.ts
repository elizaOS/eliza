import { describe, expect, test } from "bun:test";
import {
  enqueueTenantDbDeprovision,
  readTenantDbDeprovisionJobData,
} from "../tenant-db-deprovision-job-service";
import type { ContainerJobInsert, ContainerJobsWriter } from "../container-job-service";
import { JOB_TYPES } from "../provisioning-job-types";

describe("readTenantDbDeprovisionJobData", () => {
  test("extracts appId and clusterId", () => {
    expect(
      readTenantDbDeprovisionJobData({ data: { appId: "app-1", clusterId: "cluster-1" } }),
    ).toEqual({ appId: "app-1", clusterId: "cluster-1" });
  });

  test("throws when appId or clusterId missing", () => {
    expect(() => readTenantDbDeprovisionJobData({ data: {} })).toThrow(/missing data.appId/);
    expect(() => readTenantDbDeprovisionJobData({ data: { appId: "a" } })).toThrow(
      /missing data.clusterId/,
    );
  });
});

describe("enqueueTenantDbDeprovision", () => {
  test("inserts a TENANT_DB_DEPROVISION job (pg-free writer)", async () => {
    const inserted: ContainerJobInsert[] = [];
    const writer: ContainerJobsWriter = {
      insertJob: async (j) => {
        inserted.push(j);
        return { id: "job-1" };
      },
    };
    const r = await enqueueTenantDbDeprovision(writer, {
      appId: "app-1",
      clusterId: "cluster-1",
      organizationId: "org-1",
    });
    expect(r.id).toBe("job-1");
    expect(inserted[0]).toEqual({
      type: JOB_TYPES.TENANT_DB_DEPROVISION,
      organizationId: "org-1",
      data: { appId: "app-1", clusterId: "cluster-1" },
    });
  });
});
