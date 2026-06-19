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
  controlPlaneUrl?: string;
  databaseUrl?: string;
}

export interface CreateCloudAgentOptions {
  dockerImage?: string;
  alwaysOn?: boolean;
  statefulRuntime?: boolean;
  modelTooLargeForShared?: boolean;
  autoProvision?: boolean;
}

export async function createCloudAgent(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  agentName: string,
  options: CreateCloudAgentOptions = {},
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
      ...(options.alwaysOn !== undefined ? { alwaysOn: options.alwaysOn } : {}),
      ...(options.statefulRuntime !== undefined
        ? { statefulRuntime: options.statefulRuntime }
        : {}),
      ...(options.modelTooLargeForShared !== undefined
        ? { modelTooLargeForShared: options.modelTooLargeForShared }
        : {}),
      ...(options.autoProvision !== undefined
        ? { autoProvision: options.autoProvision }
        : {}),
    }),
  });

  expect(
    [200, 201, 202],
    `agent create returned ${res.status}: ${await res.clone().text()}`,
  ).toContain(res.status);

  const body = (await res.json()) as {
    id?: string;
    agentId?: string;
    sandboxId?: string;
    data?: { id?: string; agentId?: string; sandboxId?: string };
  };
  const sandboxId =
    body.sandboxId ??
    body.agentId ??
    body.id ??
    body.data?.sandboxId ??
    body.data?.agentId ??
    body.data?.id;
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

export async function getPersistedAgentSummary(
  sandboxId: string,
  organizationId: string,
): Promise<{
  status: string;
  executionTier: string;
  sandboxId: string | null;
  billingStatus: string;
}> {
  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const row = await agentSandboxesRepository.findByIdAndOrg(
    sandboxId,
    organizationId,
  );
  expect(row, `expected persisted sandbox ${sandboxId}`).toBeTruthy();
  if (!row) {
    throw new Error(`Expected persisted sandbox ${sandboxId}`);
  }
  return {
    status: row.status,
    executionTier: row.execution_tier,
    sandboxId: row.sandbox_id,
    billingStatus: row.billing_status,
  };
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
  if (endpoints.controlPlaneUrl && endpoints.databaseUrl) {
    return fetch(
      `${endpoints.controlPlaneUrl}/api/v1/cron/process-provisioning-jobs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          "Content-Type": "application/json",
          "x-eliza-cloud-database-url": endpoints.databaseUrl,
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      },
    );
  }

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

export interface ActiveBillingResourceSummary {
  resourceType: string;
  resourceId: string;
}

export async function listActiveBillingResources(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
): Promise<ActiveBillingResourceSummary[]> {
  const res = await fetch(`${endpoints.apiUrl}/api/v1/billing/active`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(
    res.status,
    `active billing returned ${res.status}: ${await res.clone().text()}`,
  ).toBe(200);
  const body = (await res.json()) as {
    resources?: ActiveBillingResourceSummary[];
  };
  expect(body.resources, "expected active billing resources").toBeInstanceOf(
    Array,
  );
  if (!body.resources) {
    throw new Error("Expected active billing resources");
  }
  return body.resources;
}

export interface BridgeRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export async function sendAgentBridgeRequest(
  endpoints: ProvisioningEndpoints,
  apiKey: string,
  sandboxId: string,
  rpc: BridgeRpcRequest,
): Promise<BridgeRpcResponse> {
  const res = await fetch(
    `${endpoints.apiUrl}/api/v1/eliza/agents/${sandboxId}/bridge`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rpc),
    },
  );
  expect(
    res.status,
    `agent bridge returned ${res.status}: ${await res.clone().text()}`,
  ).toBe(200);
  const body = (await res.json()) as BridgeRpcResponse;
  expect(body.jsonrpc).toBe("2.0");
  return body;
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
