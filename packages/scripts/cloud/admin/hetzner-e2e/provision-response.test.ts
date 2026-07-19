import { describe, expect, test } from "bun:test";
import { provisionJobId } from "./provision-response";

describe("Hetzner E2E provisioning response", () => {
  test("returns the job id for dedicated asynchronous provisioning", () => {
    expect(provisionJobId(202, { data: { jobId: "job-123" } })).toBe(
      "job-123",
    );
  });

  test("accepts an already-running shared-runtime agent without a job", () => {
    expect(
      provisionJobId(200, {
        source: "shared_runtime",
        data: { status: "running" },
      }),
    ).toBeNull();
  });

  test("fails closed on malformed or non-running success responses", () => {
    expect(() => provisionJobId(202, { data: {} })).toThrow(
      "Provision response missing jobId",
    );
    expect(() =>
      provisionJobId(200, {
        source: "shared_runtime",
        data: { status: "stopped" },
      }),
    ).toThrow("not a running shared-runtime agent");
  });
});
