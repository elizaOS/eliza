/** Proves ambiguous voice clones remain visible in the authenticated manual reconciliation queue. */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getUserJobs = mock(async () => [
  {
    id: "job-reconcile-1",
    voiceName: "Accepted Maybe",
    jobType: "professional",
    status: "reconciliation_required",
    progress: 0,
    errorMessage: "account acct_private_456 samples submission failed",
    elevenlabsVoiceId: "pvc-accepted-1",
    metadata: {
      providerSubmissionState: "submission_unknown",
      providerLastStep: "samples",
    },
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
    startedAt: new Date("2026-09-02T12:00:01.000Z"),
  },
  {
    id: "job-failed-1",
    voiceName: "Rejected",
    jobType: "instant",
    status: "failed",
    progress: 0,
    errorMessage: "Provider rejected the request",
    elevenlabsVoiceId: null,
    metadata: {},
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
    startedAt: new Date("2026-09-02T12:00:01.000Z"),
  },
]);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
  }),
}));
mock.module("@/lib/services/voice-cloning", () => ({
  voiceCloningService: { getUserJobs },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

test("returns reconciliation state and provider locator while excluding terminal failures", async () => {
  const response = await app.request("/");

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    success: true,
    total: 1,
    jobs: [
      {
        id: "job-reconcile-1",
        status: "reconciliation_required",
        errorMessage: "provider_work_reconciliation_required",
        reconciliationRequired: true,
        providerState: "submission_unknown",
        providerStep: "samples",
        providerVoiceId: "pvc-accepted-1",
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("acct_private_456");
  expect(getUserJobs).toHaveBeenCalledWith("org-1", "user-1");
});
