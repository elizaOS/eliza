/**
 * ContainerJobsWriter — the insert seam backing container job enqueue.
 * Pure unit tests with a deterministic repository fixture: field mapping
 * (type / organization_id / user_id null vs undefined / data), the
 * deterministic-id conflict guard, and the canonical-json equality check
 * that ignores object key order.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const create = mock();
const createOrGetById = mock();

mock.module("../../../db/repositories/jobs", () => ({
  jobsRepository: {
    create,
    createOrGetById,
  },
}));

const { JobsRepositoryContainerJobsWriter } = await import("../container-jobs-writer");

beforeEach(() => {
  create.mockReset();
  createOrGetById.mockReset();
});

const writer = new JobsRepositoryContainerJobsWriter();

const BASE_JOB = {
  type: "container_provision",
  organizationId: "org-123",
  data: { containerId: "c-1", region: "us-east" },
};

describe("JobsRepositoryContainerJobsWriter.insertJob", () => {
  test("maps fields onto the jobs row shape and returns the created id", async () => {
    create.mockResolvedValue({
      id: "job-1",
      type: BASE_JOB.type,
      organization_id: BASE_JOB.organizationId,
      user_id: null,
      data: BASE_JOB.data,
    });

    const result = await writer.insertJob(BASE_JOB);

    expect(result).toEqual({ id: "job-1" });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.type).toBe("container_provision");
    expect(arg.organization_id).toBe("org-123");
    expect(arg.user_id).toBeNull();
    expect(arg.data).toEqual(BASE_JOB.data);
    expect(arg).not.toHaveProperty("id");
  });

  test("passes user_id through when provided, null when absent", async () => {
    create.mockResolvedValue({
      id: "job-2",
      type: BASE_JOB.type,
      organization_id: BASE_JOB.organizationId,
      user_id: "user-9",
      data: BASE_JOB.data,
    });

    const withUser = await writer.insertJob({ ...BASE_JOB, userId: "user-9" });
    expect(withUser).toEqual({ id: "job-2" });
    expect(create.mock.calls[0][0].user_id).toBe("user-9");

    create.mockResolvedValue({
      id: "job-3",
      type: BASE_JOB.type,
      organization_id: BASE_JOB.organizationId,
      user_id: null,
      data: BASE_JOB.data,
    });
    await writer.insertJob(BASE_JOB);
    expect(create.mock.calls[1][0].user_id).toBeNull();
  });

  test("uses createOrGetById and forwards the deterministic id", async () => {
    createOrGetById.mockResolvedValue({
      id: "det-1",
      type: BASE_JOB.type,
      organization_id: BASE_JOB.organizationId,
      user_id: null,
      data: BASE_JOB.data,
    });

    const result = await writer.insertJob({ ...BASE_JOB, id: "det-1" });

    expect(result).toEqual({ id: "det-1" });
    expect(createOrGetById).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(createOrGetById.mock.calls[0][0].id).toBe("det-1");
  });

  test("accepts a returned row whose data has the same canonical content in a different key order", async () => {
    const dataIn = { containerId: "c-1", region: "us-east" };
    const dataOut = { region: "us-east", containerId: "c-1" };
    createOrGetById.mockResolvedValue({
      id: "det-2",
      type: BASE_JOB.type,
      organization_id: BASE_JOB.organizationId,
      user_id: null,
      data: dataOut,
    });

    const result = await writer.insertJob({ ...BASE_JOB, id: "det-2", data: dataIn });
    expect(result).toEqual({ id: "det-2" });
  });

  test("throws when the deterministic id is bound to a different intent", async () => {
    createOrGetById.mockResolvedValue({
      id: "det-3",
      type: "container_deprovision",
      organization_id: "org-123",
      user_id: null,
      data: { containerId: "c-1" },
    });

    await expect(writer.insertJob({ ...BASE_JOB, id: "det-3" })).rejects.toThrow(
      "Deterministic job id det-3 is bound to a different intent",
    );
  });

  test("throws when the canonical data differs (same keys, different values)", async () => {
    createOrGetById.mockResolvedValue({
      id: "det-4",
      ...BASE_JOB,
      user_id: null,
      data: { containerId: "c-2", region: "us-east" },
    });

    await expect(writer.insertJob({ ...BASE_JOB, id: "det-4" })).rejects.toThrow(
      "Deterministic job id det-4 is bound to a different intent",
    );
  });
});
