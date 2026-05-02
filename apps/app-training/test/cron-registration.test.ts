import { describe, expect, it, vi } from "vitest";
import { registerSkillScoringCron } from "../src/core/skill-scoring-cron.js";
import { registerTrajectoryExportCron } from "../src/core/trajectory-export-cron.js";

function createCronService(
  jobs: Array<{
    id: string;
    name: string;
    createdAtMs: number;
    updatedAtMs: number;
  }>,
) {
  return {
    jobs,
    createJob: vi.fn(async (input: { name: string }) => {
      jobs.push({
        id: `created-${jobs.length + 1}`,
        name: input.name,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      return {};
    }),
    listJobs: vi.fn(async () => jobs),
    deleteJob: vi.fn(async (jobId: string) => {
      const index = jobs.findIndex((job) => job.id === jobId);
      if (index === -1) {
        return false;
      }
      jobs.splice(index, 1);
      return true;
    }),
  };
}

function createRuntime(cronService: ReturnType<typeof createCronService>) {
  const registerEvent = vi.fn();
  return {
    getService: (name: string) => (name === "CRON" ? cronService : null),
    logger: { info() {}, warn() {}, error() {} },
    registerEvent,
  };
}

describe("Track C cron registration", () => {
  it("prunes duplicate trajectory-export jobs and avoids creating another one", async () => {
    const cronService = createCronService([
      {
        id: "old-job",
        name: "track-c-trajectory-export-nightly",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: "new-job",
        name: "track-c-trajectory-export-nightly",
        createdAtMs: 2,
        updatedAtMs: 2,
      },
    ]);
    const runtime = createRuntime(cronService);

    await registerTrajectoryExportCron(runtime);

    expect(cronService.listJobs).toHaveBeenCalledWith({
      includeDisabled: true,
    });
    expect(cronService.deleteJob).toHaveBeenCalledTimes(1);
    expect(cronService.deleteJob).toHaveBeenCalledWith("old-job");
    expect(cronService.createJob).not.toHaveBeenCalled();
    expect(runtime.registerEvent).toHaveBeenCalledTimes(1);
  });

  it("creates the skill-scoring job only once and does not re-register the event handler", async () => {
    const cronService = createCronService([]);
    const runtime = createRuntime(cronService);

    await registerSkillScoringCron(runtime);
    await registerSkillScoringCron(runtime);

    expect(cronService.createJob).toHaveBeenCalledTimes(1);
    expect(cronService.listJobs).toHaveBeenCalledTimes(2);
    expect(runtime.registerEvent).toHaveBeenCalledTimes(1);
  });
});
