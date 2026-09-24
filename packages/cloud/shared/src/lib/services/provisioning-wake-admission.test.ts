/** Automatic cold recovery retains the observed generation at durable admission. */
import { expect, spyOn, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { provisioningJobService } from "./provisioning-jobs";

test("automatic wake uses the wake job and rejects a changed lifecycle before reuse or insertion", async () => {
  const sentinel = new Error("admission inspected");
  const enqueue = spyOn(
    provisioningJobService as unknown as {
      enqueueLifecycleJob: (options: {
        jobType: string;
        jobData: Record<string, unknown>;
        validateSandbox?: (sandbox: { lifecycle_revision: number }) => void;
      }) => Promise<never>;
    },
    "enqueueLifecycleJob",
  ).mockImplementation(async (options) => {
    expect(options.jobType).toBe("agent_wake");
    expect(options.jobData).toEqual({
      agentId: "agent",
      organizationId: "org",
      userId: "user",
    });
    expect(options.validateSandbox).toBeFunction();
    expect(() => options.validateSandbox?.({ lifecycle_revision: 19 })).not.toThrow();
    expect(() => options.validateSandbox?.({ lifecycle_revision: 20 })).toThrow(
      "Agent state changed while waking",
    );
    try {
      options.validateSandbox?.({ lifecycle_revision: 20 });
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect(error).toMatchObject({
        code: "AGENT_WAKE_AUTHORITY_CHANGED",
        context: {
          agentId: "agent",
          organizationId: "org",
          expectedLifecycleRevision: 19,
          actualLifecycleRevision: 20,
        },
      });
    }
    throw sentinel;
  });
  try {
    await expect(
      provisioningJobService.enqueueAgentWakeOnce({
        agentId: "agent",
        organizationId: "org",
        userId: "user",
        expectedLifecycleRevision: 19,
      }),
    ).rejects.toBe(sentinel);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally {
    enqueue.mockRestore();
  }
});
