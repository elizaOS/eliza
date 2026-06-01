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

export async function createCloudAgent(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  agentName: string,
  options: { dockerImage?: string } = {},
): Promise<string> {
  const res = await fetch(`${endpoints.apiUrl}/api/v1/eliza/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentName,
      ...(options.dockerImage ? { dockerImage: options.dockerImage } : {}),
    }),
  });

  expect(
    [200, 201, 202],
    `agent create returned ${res.status}: ${await res.clone().text()}`,
  ).toContain(res.status);

  const body = (await res.json()) as {
    id?: string;
    sandboxId?: string;
    data?: { id?: string; sandboxId?: string };
  };
  const sandboxId =
    body.sandboxId ?? body.id ?? body.data?.sandboxId ?? body.data?.id;
  expect(sandboxId, "expected sandbox id from create response").toBeTruthy();
  return sandboxId as string;
}

export async function getPersistedDockerImage(
  sandboxId: string,
  organizationId: string,
): Promise<string | null> {
  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const row = await agentSandboxesRepository.findByIdAndOrg(
    sandboxId,
    organizationId,
  );
  expect(row, `expected persisted sandbox ${sandboxId}`).toBeTruthy();
  return row?.docker_image ?? null;
}

export async function startAgentProvisioning(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
): Promise<void> {
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/eliza/agents/${sandboxId}/provision`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  expect(
    [200, 202, 409],
    `agent provision returned ${res.status}: ${await res.clone().text()}`,
  ).toContain(res.status);
}

export async function tickProvisioning(
  endpoints: ProvisioningEndpoints,
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  return fetch(`${endpoints.apiUrl}/api/v1/cron/process-provisioning-jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
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

export async function agentLifecycleAction(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
  action: "sleep" | "wake" | "suspend" | "resume",
  acceptable: number[] = [200, 202, 409],
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/eliza/agents/${sandboxId}/${action}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  expect(
    acceptable,
    `agent ${action} returned ${res.status}: ${text}`,
  ).toContain(res.status);
  return { status: res.status, body };
}

export interface BackupSummary {
  id: string;
  snapshotType: string;
  backupKind?: string;
  parentBackupId?: string | null;
  sizeBytes?: number | null;
  createdAt?: string;
}

export async function listBackups(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
): Promise<BackupSummary[]> {
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/eliza/agents/${sandboxId}/backups`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  expect(res.status, `backups list returned ${res.status}`).toBe(200);
  const body = (await res.json()) as { data?: BackupSummary[] };
  return body.data ?? [];
}

export async function runScheduledBackups(
  endpoints: ProvisioningEndpoints,
  opts: { intervalMs?: number } = {},
): Promise<{ scanned: number; enqueued: number }> {
  const intervalMs = opts.intervalMs ?? 0;
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/cron/agent-backups?intervalMs=${intervalMs}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "Content-Type": "application/json",
      },
    },
  );
  expect(
    res.status,
    `scheduled backups cron returned ${res.status}: ${await res.clone().text()}`,
  ).toBe(200);
  const body = (await res.json()) as { scanned?: number; enqueued?: number };
  return { scanned: body.scanned ?? 0, enqueued: body.enqueued ?? 0 };
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
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    onTick?: () => Promise<void>;
  } = {},
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
