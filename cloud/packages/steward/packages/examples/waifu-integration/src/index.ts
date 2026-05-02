import { type PolicyRule, StewardApiError, StewardClient, type TxRecord } from "@stwd/sdk";
import type { ApiResponse, WebhookEvent } from "@stwd/shared";

const BASE_CHAIN_ID = 8453;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const UNISWAP_UNIVERSAL_ROUTER = "0x6fF5693B99212Da76ad316178A184AB56D299b43";

const config = {
  apiUrl: process.env.STEWARD_API_URL ?? "http://127.0.0.1:3200",
  tenantId: process.env.STEWARD_TENANT_ID ?? "waifu-fun",
  apiKey: process.env.STEWARD_API_KEY ?? "waifu-demo-secret",
  tenantName: process.env.STEWARD_TENANT_NAME ?? "waifu.fun",
  webhookPort: Number(process.env.WAIFU_WEBHOOK_PORT ?? "4210"),
  webhookSecret: process.env.WAIFU_WEBHOOK_SECRET ?? "waifu-webhook-secret",
  webhookPath: process.env.WAIFU_WEBHOOK_PATH ?? "/steward-events",
  agentId: process.env.WAIFU_AGENT_ID ?? "milady-trader",
  agentName: process.env.WAIFU_AGENT_NAME ?? "Milady Trader",
  platformId: process.env.WAIFU_PLATFORM_ID ?? "waifu.fun:milady-trader",
};

type TenantPayload = {
  id: string;
  name: string;
  apiKeyHash: string;
  webhookUrl?: string;
  defaultPolicies?: PolicyRule[];
};

type PendingApprovalRecord = {
  queueId: string;
  status: string;
  requestedAt: string;
  transaction: {
    id: string;
    agentId: string;
    status: string;
    request: {
      to: string;
      value: string;
      data?: string;
      chainId: number;
    };
    policyResults: Array<{ type: string; passed: boolean; reason?: string }>;
  };
};

type ReceivedWebhook = {
  event: string;
  signature: string;
  payload: WebhookEvent;
};

const webhookUrl = `http://127.0.0.1:${config.webhookPort}${config.webhookPath}`;

function parseEther(value: string): bigint {
  const [wholePart, fractionalPart = ""] = value.split(".");
  const normalizedFraction = `${fractionalPart}000000000000000000`.slice(0, 18);
  return BigInt(wholePart || "0") * 10n ** 18n + BigInt(normalizedFraction);
}

function formatEther(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = value % 10n ** 18n;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}.${fractionText}`;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function detail(label: string, value: unknown) {
  console.log(`- ${label}:`, value);
}

function weiToEthLabel(value: string): string {
  return `${formatEther(BigInt(value))} ETH`;
}

async function signWebhookPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function verifyWebhookPayload(
  payload: string,
  secret: string,
  signature: string,
): Promise<boolean> {
  const expected = await signWebhookPayload(payload, secret);
  return expected === signature;
}

function authHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Steward-Tenant": config.tenantId,
    "X-Steward-Key": config.apiKey,
  };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(authHeaders());
  const extraHeaders = new Headers(init.headers);

  extraHeaders.forEach((value, key) => {
    headers.set(key, value);
  });

  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers,
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  if (typeof payload.data === "undefined") {
    throw new Error(`Missing response data from ${path}`);
  }

  return payload.data;
}

async function registerOrUpdateTenant(defaultPolicies: PolicyRule[]) {
  section("Tenant Registration");

  const payload: TenantPayload = {
    id: config.tenantId,
    name: config.tenantName,
    apiKeyHash: config.apiKey,
    webhookUrl,
    defaultPolicies,
  };

  const createResponse = await fetch(`${config.apiUrl}/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = (await createResponse.json()) as ApiResponse<TenantPayload>;
  if (createResponse.ok && body.ok && body.data) {
    detail("tenant", body.data.id);
    detail("webhook", body.data.webhookUrl);
    return;
  }

  if (createResponse.status !== 400 || body.error !== "Tenant already exists") {
    throw new Error(body.error ?? `Failed to register tenant: ${createResponse.status}`);
  }

  await requestJson(`/tenants/${encodeURIComponent(config.tenantId)}/webhook`, {
    method: "PUT",
    body: JSON.stringify({
      webhookUrl,
      defaultPolicies,
    }),
  });

  const tenant = await requestJson<TenantPayload>(
    `/tenants/${encodeURIComponent(config.tenantId)}`,
  );
  detail("tenant", `${tenant.id} (reused)`);
  detail("webhook", tenant.webhookUrl ?? "not set");
}

async function fetchPendingApprovals(agentId: string): Promise<PendingApprovalRecord[]> {
  return requestJson<PendingApprovalRecord[]>(`/vault/${encodeURIComponent(agentId)}/pending`);
}

async function approvePending(agentId: string, txId: string) {
  return requestJson<{ txId: string; txHash: string }>(
    `/vault/${encodeURIComponent(agentId)}/approve/${encodeURIComponent(txId)}`,
    { method: "POST" },
  );
}

async function fetchHistory(agentId: string) {
  return requestJson<TxRecord[]>(`/vault/${encodeURIComponent(agentId)}/history`);
}

async function sendWebhookNotification(event: WebhookEvent) {
  const body = JSON.stringify(event);
  const signature = await signWebhookPayload(body, config.webhookSecret);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Event": event.type,
      "X-Steward-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Webhook delivery failed with status ${response.status}`);
  }
}

async function startWebhookServer(received: ReceivedWebhook[]) {
  section("Webhook Receiver");

  const server = Bun.serve({
    port: config.webhookPort,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== config.webhookPath) {
        return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const event = request.headers.get("X-Steward-Event") ?? "unknown";
      const signature = request.headers.get("X-Steward-Signature") ?? "";
      const rawBody = await request.text();
      const isValid = await verifyWebhookPayload(rawBody, config.webhookSecret, signature);

      if (!isValid) {
        return new Response(JSON.stringify({ ok: false, error: "Invalid webhook signature" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payload = JSON.parse(rawBody) as WebhookEvent;
      received.push({ event, signature, payload });

      console.log(`[webhook] ${event} for ${payload.agentId}`);
      detail("webhook txId", payload.data.txId ?? "n/a");
      detail("webhook reason", payload.data.summary ?? "n/a");

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  detail("listening", webhookUrl);
  return server;
}

function buildDefaultPolicies(agentWalletAddress: string): PolicyRule[] {
  return [
    {
      id: "waifu-spending-limit",
      type: "spending-limit",
      enabled: true,
      // Current API requires a weekly ceiling in addition to the per-tx and daily limits.
      config: {
        maxPerTx: parseEther("0.1").toString(),
        maxPerDay: parseEther("1").toString(),
        maxPerWeek: parseEther("3").toString(),
      },
    },
    {
      id: "waifu-approved-addresses",
      type: "approved-addresses",
      enabled: true,
      // The demo keeps the required Uniswap + USDC allowlist and adds the wallet itself
      // so the reference flow can execute against a funded test wallet without swap calldata.
      config: {
        mode: "whitelist",
        addresses: [UNISWAP_UNIVERSAL_ROUTER, USDC_ADDRESS, agentWalletAddress],
      },
    },
    {
      id: "waifu-auto-approve-threshold",
      type: "auto-approve-threshold",
      enabled: true,
      config: {
        threshold: parseEther("0.01").toString(),
      },
    },
  ];
}

function printPolicySummary(policies: PolicyRule[]) {
  for (const policy of policies) {
    detail(`policy ${policy.type}`, policy.config);
  }
}

function printPolicyResults(
  label: string,
  results: Array<{ type: string; passed: boolean; reason?: string }>,
) {
  console.log(label);
  for (const result of results) {
    console.log(
      `  ${result.passed ? "PASS" : "FAIL"} ${result.type}${result.reason ? ` - ${result.reason}` : ""}`,
    );
  }
}

async function main() {
  const receivedWebhooks: ReceivedWebhook[] = [];
  const server = await startWebhookServer(receivedWebhooks);

  try {
    const client = new StewardClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
      tenantId: config.tenantId,
    });

    const bootstrapPolicies = buildDefaultPolicies("0x0000000000000000000000000000000000000000");
    await registerOrUpdateTenant(bootstrapPolicies);

    section("Agent Wallet");

    let agent;
    try {
      agent = await client.createWallet(config.agentId, config.agentName, config.platformId);
      detail("created", `${agent.id} -> ${agent.walletAddress}`);
    } catch (error) {
      if (!(error instanceof StewardApiError) || error.status !== 400) {
        throw error;
      }

      agent = await client.getAgent(config.agentId);
      detail("reused", `${agent.id} -> ${agent.walletAddress}`);
    }

    detail("tenant", agent.tenantId);
    detail("platform id", agent.platformId ?? "not set");

    section("Policy Setup");
    const policies = buildDefaultPolicies(agent.walletAddress);
    await client.setPolicies(agent.id, policies);
    const storedPolicies = await client.getPolicies(agent.id);
    printPolicySummary(storedPolicies);

    section("Tenant View");
    const listedAgents = await client.listAgents();
    detail("tenant agent count", listedAgents.length);
    detail("agent ids", listedAgents.map((entry) => entry.id).join(", "));

    section("Message Signing");
    const message = `waifu.fun custody proof for ${agent.id} on Base`;
    const signature = await client.signMessage(agent.id, message);
    detail("message", message);
    detail("signature", signature.signature);

    section("Transaction Flow");
    console.log(
      "Steward enforces policy at the wallet backend. waifu.fun decides when to auto-approve or escalate.",
    );

    const smallTxValue = parseEther("0.005").toString();
    try {
      const smallTx = await client.signTransaction(agent.id, {
        to: agent.walletAddress,
        value: smallTxValue,
        chainId: BASE_CHAIN_ID,
      });

      if ("txHash" in smallTx) {
        detail("small tx", `auto-approved and signed (${smallTx.txHash})`);
      }
    } catch (error) {
      console.log("Small tx passed policy but could not be broadcast.");
      detail("likely cause", "fund the demo wallet with ETH on Base so the signer can pay gas");
      detail("error", error instanceof Error ? error.message : "Unknown error");
    }

    const mediumTxValue = parseEther("0.05").toString();
    const mediumTx = await client.signTransaction(agent.id, {
      to: agent.walletAddress,
      value: mediumTxValue,
      chainId: BASE_CHAIN_ID,
    });

    if (!("status" in mediumTx) || mediumTx.status !== "pending_approval") {
      throw new Error("Expected medium transaction to require manual approval");
    }

    printPolicyResults(
      `Medium tx (${weiToEthLabel(mediumTxValue)}) requested manual approval:`,
      mediumTx.results,
    );

    // The current SDK response omits txId for pending approvals, so the platform checks the pending queue.
    const pendingApprovals = await fetchPendingApprovals(agent.id);
    const mediumPending = pendingApprovals.find(
      (entry) => entry.transaction.request.value === mediumTxValue,
    );
    if (!mediumPending) {
      throw new Error("Could not find the pending approval for the medium transaction");
    }

    await sendWebhookNotification({
      type: "approval_required",
      tenantId: config.tenantId,
      agentId: agent.id,
      timestamp: new Date(),
      data: {
        txId: mediumPending.transaction.id,
        queueId: mediumPending.queueId,
        value: mediumTxValue,
        to: mediumPending.transaction.request.to,
        summary: "milady-trader exceeded the auto-approve threshold and needs waifu.fun approval",
        policyResults: mediumPending.transaction.policyResults,
      },
    });

    const mediumApproval = await approvePending(agent.id, mediumPending.transaction.id);
    detail("medium tx", `approved and signed (${mediumApproval.txHash})`);

    const largeTxValue = parseEther("0.2").toString();
    try {
      await client.signTransaction(agent.id, {
        to: agent.walletAddress,
        value: largeTxValue,
        chainId: BASE_CHAIN_ID,
      });
      throw new Error("Expected large transaction to be rejected by the spending limit");
    } catch (error) {
      if (!(error instanceof StewardApiError)) {
        throw error;
      }

      console.log(`Large tx (${weiToEthLabel(largeTxValue)}) was rejected before signing.`);
      printPolicyResults(
        "Policy engine result:",
        (error.data?.results as
          | Array<{ type: string; passed: boolean; reason?: string }>
          | undefined) ?? [],
      );
    }

    section("Lifecycle Summary");
    const history = await fetchHistory(agent.id);
    for (const entry of history) {
      detail(
        "history",
        `${entry.status} ${weiToEthLabel(entry.request.value)} -> ${entry.request.to} @ ${new Date(entry.createdAt).toISOString()}`,
      );
      if (entry.txHash) {
        detail("tx hash", entry.txHash);
      }
    }
    detail("webhook deliveries", receivedWebhooks.length);
    detail("received events", receivedWebhooks.map((entry) => entry.event).join(", ") || "none");
  } finally {
    server.stop();
  }
}

await main().catch((error) => {
  console.error("\nWaifu integration example failed.");
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
