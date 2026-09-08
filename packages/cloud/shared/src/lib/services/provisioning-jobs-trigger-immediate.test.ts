/**
 * The provisioning nudge contract treats an HTTP rejection as a failed
 * dispatch and never calls the retired Worker no-op. Durable job processing
 * remains owned by the provisioning daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ProvisioningJobService } from "./provisioning-jobs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function directEnv() {
  return {
    CONTAINER_CONTROL_PLANE_URL: "https://control-plane.example.test",
    CONTAINER_CONTROL_PLANE_TOKEN: "control-plane-token",
    DATABASE_URL: "postgres://worker-db.example.test/eliza",
  };
}

describe("ProvisioningJobService.triggerImmediate", () => {
  test("rejects when the only configured nudge endpoint returns non-success", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 401 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(new ProvisioningJobService().triggerImmediate(directEnv())).rejects.toMatchObject({
      code: "PROVISIONING_IMMEDIATE_TRIGGER_REJECTED",
      context: { target: "control-plane", status: 401 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not call the retired Worker no-op without a direct nudge", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(new ProvisioningJobService().triggerImmediate({})).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
