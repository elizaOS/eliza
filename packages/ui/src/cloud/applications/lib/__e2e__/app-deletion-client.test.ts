import { expect, test } from "vitest";
import { deleteAppAndWait } from "../app-deletion-client";

const appId = "original-app";
const jobId = "original-job";
const pending = {
  status: 202,
  data: { success: false, state: "pending", status: "pending", appId, jobId },
};
const completed = {
  status: 200,
  data: {
    success: true,
    data: {
      id: jobId,
      type: "app_delete",
      status: "completed",
      result: { appDeleted: true, appId, deletionJobId: jobId },
    },
  },
};

test("the app helper waits for the original job receipt before reporting success", async () => {
  const paths: string[] = [];
  const responses = [
    pending,
    {
      status: 200,
      data: {
        success: true,
        data: { id: jobId, type: "app_delete", status: "in_progress" },
      },
    },
    completed,
  ];
  await deleteAppAndWait(appId, {
    pollIntervalMs: 0,
    request: async (path) => {
      paths.push(path);
      return responses.shift()!;
    },
  });
  expect(paths).toEqual([
    `/api/v1/apps/${appId}`,
    `/api/v1/jobs/${jobId}`,
    `/api/v1/jobs/${jobId}`,
  ]);
});

test("an acknowledged complete replay needs no additional request", async () => {
  let requests = 0;
  await deleteAppAndWait(appId, {
    request: async () => {
      requests++;
      return {
        status: 200,
        data: {
          success: true,
          state: "completed",
          status: "completed",
          appId,
          jobId,
        },
      };
    },
  });
  expect(requests).toBe(1);
});

for (const status of ["failed", "cancelled"])
  test(`a ${status} job never reports app deletion success`, async () => {
    const replies = [
      pending,
      {
        status: 200,
        data: {
          success: true,
          data: { id: jobId, type: "app_delete", status },
        },
      },
    ];
    await expect(
      deleteAppAndWait(appId, { request: async () => replies.shift()! }),
    ).rejects.toThrow("requires recovery");
  });

test("a completed job with a different app receipt is rejected", async () => {
  const replies = [
    pending,
    {
      ...completed,
      data: {
        success: true,
        data: {
          ...completed.data.data,
          result: {
            appDeleted: true,
            appId: "foreign-app",
            deletionJobId: jobId,
          },
        },
      },
    },
  ];
  await expect(
    deleteAppAndWait(appId, { request: async () => replies.shift()! }),
  ).rejects.toThrow("receipt is missing");
});

test("legacy success false is not cast into a successful app deletion", async () => {
  await expect(
    deleteAppAndWait(appId, {
      request: async () => ({
        status: 200,
        data: { success: false, error: "cleanup failed" },
      }),
    }),
  ).rejects.toThrow("cleanup failed");
});

test("cancelling the wait never sends a job cancellation or another DELETE", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  await expect(
    deleteAppAndWait(appId, {
      signal: controller.signal,
      request: async (path) => {
        paths.push(path);
        if (paths.length === 2)
          controller.abort(new Error("local wait cancelled"));
        return paths.length === 1
          ? pending
          : {
              status: 200,
              data: {
                success: true,
                data: { id: jobId, type: "app_delete", status: "in_progress" },
              },
            };
      },
    }),
  ).rejects.toThrow("local wait cancelled");
  expect(paths).toEqual([`/api/v1/apps/${appId}`, `/api/v1/jobs/${jobId}`]);
});

test("poll timeout stops only the client wait", async () => {
  const methods: Array<string | undefined> = [];
  await expect(
    deleteAppAndWait(appId, {
      timeoutMs: 5,
      pollIntervalMs: 100,
      request: async (_path, init) => {
        methods.push(init.method);
        return methods.length === 1
          ? pending
          : {
              status: 200,
              data: {
                success: true,
                data: { id: jobId, type: "app_delete", status: "in_progress" },
              },
            };
      },
    }),
  ).rejects.toThrow();
  expect(methods).toEqual(["DELETE", undefined]);
});
