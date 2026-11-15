import { expect, test } from "vitest";
import {
  AppDeletionPendingError,
  deleteAppAndWait,
  resumeAppDeletionAndWait,
} from "../app-deletion-client";

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
      result: {
        appDeleted: true,
        appId,
        deletionJobId: jobId,
        cleanupConfirmed: true,
      },
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

for (const cleanupConfirmed of [undefined, false]) {
  test(`a completed job without cleanup confirmation ${cleanupConfirmed} remains pending`, async () => {
    let calls = 0;
    const error = await deleteAppAndWait(appId, {
      request: async () =>
        ++calls === 1
          ? pending
          : {
              ...completed,
              data: {
                ...completed.data,
                data: {
                  ...completed.data.data,
                  result: { ...completed.data.data.result, cleanupConfirmed },
                },
              },
            },
    }).catch((error) => error);
    expect(error).toBeInstanceOf(AppDeletionPendingError);
    expect(error).toMatchObject({
      appId,
      jobId,
      reason: "observation_unavailable",
    });
  });
}

test("lost status observation retains original identity and resumes with GET only", async () => {
  const paths: Array<{ path: string; method?: string }> = [];
  const error = await deleteAppAndWait(appId, {
    request: async (path, init) => {
      paths.push({ path, method: init.method });
      if (init.method === "DELETE") return pending;
      throw new TypeError("controlled transport loss");
    },
  }).catch((error) => error);
  expect(error).toBeInstanceOf(AppDeletionPendingError);
  expect(error).toMatchObject({
    appId,
    jobId,
    reason: "observation_unavailable",
  });
  await resumeAppDeletionAndWait(error.appId, error.jobId, {
    request: async (path, init) => {
      paths.push({ path, method: init.method });
      return completed;
    },
  });
  expect(paths).toEqual([
    { path: `/api/v1/apps/${appId}`, method: "DELETE" },
    { path: `/api/v1/jobs/${jobId}`, method: undefined },
    { path: `/api/v1/jobs/${jobId}`, method: undefined },
  ]);
});

test("a status deadline retains the original job for read-only recovery", async () => {
  const error = await deleteAppAndWait(appId, {
    timeoutMs: 5,
    pollIntervalMs: 100,
    request: async (_path, init) =>
      init.method === "DELETE"
        ? pending
        : {
            status: 200,
            data: {
              success: true,
              data: { id: jobId, type: "app_delete", status: "in_progress" },
            },
          },
  }).catch((error) => error);
  expect(error).toBeInstanceOf(AppDeletionPendingError);
  expect(error).toMatchObject({
    appId,
    jobId,
    reason: "observation_unavailable",
  });
});
