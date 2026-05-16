/**
 * Helpers for driving the provisioning lifecycle in tests.
 *
 * Cron routes require the CRON_SECRET bearer; the stack fixture sets that
 * to `test-cron-secret`. State polling uses `expect.poll`-friendly fetches
 * against the cloud-api worker.
 */

import { expect } from "@playwright/test";

const CRON_SECRET = "test-cron-secret";

export interface ProvisioningEndpoints {
  apiUrl: string;
}

export async function tickProvisioning(
  endpoints: ProvisioningEndpoints,
): Promise<Response> {
  return fetch(
    `${endpoints.apiUrl}/api/v1/cron/process-provisioning-jobs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "Content-Type": "application/json",
      },
    },
  );
}

export async function tickCleanupStuck(
  endpoints: ProvisioningEndpoints,
): Promise<Response> {
  return fetch(`${endpoints.apiUrl}/api/cron/cleanup-stuck-provisioning`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      "Content-Type": "application/json",
    },
  });
}

export async function getSandboxState(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/eliza/agents/${sandboxId}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

export async function pollSandboxStatus(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
  expected: string,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: () => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await expect
    .poll(
      async () => {
        if (opts.onTick) await opts.onTick();
        const { body } = await getSandboxState(endpoints, apiKey, sandboxId);
        if (typeof body === "object" && body !== null && "status" in body) {
          return (body as { status: string }).status;
        }
        if (
          typeof body === "object" &&
          body !== null &&
          "data" in body &&
          typeof (body as { data: unknown }).data === "object"
        ) {
          const data = (body as { data: { status?: string } }).data;
          return data?.status;
        }
        return undefined;
      },
      { timeout: timeoutMs, intervals: [opts.intervalMs ?? 250] },
    )
    .toBe(expected);
}
