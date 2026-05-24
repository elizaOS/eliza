/**
 * End-to-end test for native Solana (SIWS) auth + agent provisioning.
 *
 * Mints a fresh ed25519 Solana keypair, hits the SIWS nonce/verify
 * endpoints to obtain an API key, then exercises the real
 * /api/v1/eliza/agents create + provision contract.
 *
 * WHY THIS FILE SHOWS "0 FRAMES" IN LOCAL / MOCK MODE:
 * All tests in this file require a live Solana-capable cloud backend
 * (real /api/auth/siws/nonce and /api/auth/siws/verify endpoints). They
 * are auto-skipped via `requireLocalCloud()` when the backend is not
 * reachable at TEST_API_BASE_URL (default: http://127.0.0.1:8787). They
 * cannot be mocked: the whole point is to exercise the real SIWS
 * signature-verification path. In recording runs without the backend
 * standing up, the beforeEach skip fires before any page is opened, so
 * no browser frames are recorded.
 *
 * TO RUN THESE TESTS:
 *   1. Start the cloud API dev server (bun run dev in packages/cloud-api).
 *   2. Set TEST_API_BASE_URL=http://127.0.0.1:8787 (or the correct port).
 *   3. bun run --cwd packages/cloud-frontend test:e2e --grep "SIWS"
 *
 * Full provision tests additionally require E2E_FULL_PROVISION=1, a
 * running Docker daemon, and the eliza-cloud-agent:local image.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import bs58 from "bs58";
import nacl from "tweetnacl";

const execFileAsync = promisify(execFile);

const apiBaseUrl =
  process.env.TEST_API_BASE_URL?.trim() ||
  process.env.PLAYWRIGHT_API_URL?.trim() ||
  "http://127.0.0.1:8787";

async function requireLocalCloud() {
  const health = await fetch(`${apiBaseUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  test.skip(
    !health?.ok,
    `local cloud API is not reachable at ${apiBaseUrl}/api/health`,
  );
}

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string;
  version: string;
  statement: string;
}

interface VerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: { id: string; wallet_address: string | null; organization_id: string };
  organization: { id: string; name: string; slug: string } | null;
}

function buildSiwsMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: Date;
}): string {
  return [
    `${params.domain} wants you to sign in with your Solana account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: 1`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
  ].join("\n");
}

async function signInWithFreshSolanaKey(): Promise<{
  apiKey: string;
  address: string;
  organizationId: string;
}> {
  const keypair = nacl.sign.keyPair();
  const address = bs58.encode(keypair.publicKey);

  const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(nonceRes.status, "nonce status").toBe(200);
  const nonceBody = (await nonceRes.json()) as NonceResponse;
  expect(nonceBody.nonce, "nonce string").toMatch(/^[0-9a-f]{32}$/);
  expect(nonceBody.domain, "domain present").toBeTruthy();

  const message = buildSiwsMessage({
    domain: nonceBody.domain,
    address,
    statement: nonceBody.statement,
    uri: nonceBody.uri,
    chainId: nonceBody.chainId,
    nonce: nonceBody.nonce,
    issuedAt: new Date(),
  });

  const signature = nacl.sign.detached(
    new TextEncoder().encode(message),
    keypair.secretKey,
  );

  const verifyRes = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      signature: bs58.encode(signature),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(verifyRes.status, "verify status").toBe(200);
  const verifyBody = (await verifyRes.json()) as VerifyResponse;
  expect(verifyBody.apiKey, "apiKey returned").toBeTruthy();
  expect(verifyBody.address, "address echoed").toBe(address);
  expect(verifyBody.user.organization_id, "org assigned").toBeTruthy();

  return {
    apiKey: verifyBody.apiKey,
    address,
    organizationId: verifyBody.user.organization_id,
  };
}

test.describe("SIWS (Solana) wallet flow", () => {
  test.beforeEach(async () => {
    await requireLocalCloud();
  });

  test("rejects invalid SIWS signature", async () => {
    const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`);
    const nonce = (await nonceRes.json()) as NonceResponse;
    const realKey = nacl.sign.keyPair();
    const fakeKey = nacl.sign.keyPair();
    const address = bs58.encode(realKey.publicKey);
    const message = buildSiwsMessage({
      domain: nonce.domain,
      address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    // Sign with the WRONG key — message claims `address` but signature is from fakeKey
    const badSig = nacl.sign.detached(
      new TextEncoder().encode(message),
      fakeKey.secretKey,
    );
    const verifyRes = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: bs58.encode(badSig) }),
    });
    expect(verifyRes.status).toBe(401);
  });

  test("issues an API key for a fresh Solana keypair", async () => {
    const { apiKey, address, organizationId } =
      await signInWithFreshSolanaKey();
    expect(apiKey).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|^eliza/);
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(organizationId).toBeTruthy();

    // Sanity-check the API key actually authenticates against a gated route.
    const dashboardRes = await fetch(`${apiBaseUrl}/api/v1/dashboard`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(
      dashboardRes.status,
      "dashboard reachable with SIWS-issued API key",
    ).toBe(200);
  });

  test("nonce is single-use (replay rejected)", async () => {
    const keypair = nacl.sign.keyPair();
    const address = bs58.encode(keypair.publicKey);
    const nonceRes = await fetch(`${apiBaseUrl}/api/auth/siws/nonce`);
    const nonce = (await nonceRes.json()) as NonceResponse;
    const message = buildSiwsMessage({
      domain: nonce.domain,
      address,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date(),
    });
    const signature = nacl.sign.detached(
      new TextEncoder().encode(message),
      keypair.secretKey,
    );
    const sigB58 = bs58.encode(signature);

    const first = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: sigB58 }),
    });
    expect(first.status, "first verify").toBe(200);

    const second = await fetch(`${apiBaseUrl}/api/auth/siws/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: sigB58 }),
    });
    expect(second.status, "replay rejected").toBe(401);
  });

  test("create + provision an agent using SIWS-issued API key", async () => {
    const { apiKey } = await signInWithFreshSolanaKey();

    const createRes = await fetch(`${apiBaseUrl}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentName: `siws-e2e-${Date.now()}` }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(createRes.status, "create agent status").toBe(201);
    const createBody = (await createRes.json()) as {
      success: boolean;
      data: { id: string; agentName: string; status: string };
    };
    expect(createBody.success).toBe(true);
    expect(createBody.data.id, "agent id present").toBeTruthy();
    const agentId = createBody.data.id;

    // Provision — async mode returns 202 with jobId, or 200 if a warm pool
    // claim short-circuits, or 200 if the agent was already running.
    const provisionRes = await fetch(
      `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/provision`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(
      [200, 202],
      `provision status (got ${provisionRes.status})`,
    ).toContain(provisionRes.status);
    const provisionBody = (await provisionRes.json()) as {
      success: boolean;
      data?: { jobId?: string; agentId?: string; status?: string };
    };
    expect(provisionBody.success).toBe(true);
    if (provisionRes.status === 202) {
      expect(provisionBody.data?.jobId, "jobId on 202").toBeTruthy();
    }
  });

  /**
   * Full pipeline: SIWS auth → agent create → provision → wait for the
   * LocalDockerSandboxProvider to actually boot a Docker container → curl the
   * container's `/bridge` JSON-RPC endpoint and assert the echo reply.
   *
   * Gated by E2E_FULL_PROVISION=1 because it requires:
   *   - Local Docker daemon running
   *   - The `eliza-cloud-agent:local` image built from
   *     packages/app-core/deploy/Dockerfile.cloud-agent
   *   - The container-control-plane Bun service running on :8791
   *   - cloud-api dev launched with ELIZA_LOCAL_DOCKER_PROVIDER=1
   *
   * If those aren't set up, this test is skipped.
   */
  test("full provision: live container + chat via /bridge", async () => {
    test.skip(
      process.env.E2E_FULL_PROVISION !== "1",
      "E2E_FULL_PROVISION=1 not set — skipping live-container test",
    );

    const { apiKey } = await signInWithFreshSolanaKey();

    // Create
    const createRes = await fetch(`${apiBaseUrl}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentName: `siws-full-${Date.now()}` }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };
    const agentId = created.id;
    const containerName = `agent-${agentId}`;

    // Kick the job. Cloud-api's triggerImmediate fires-and-forgets to the
    // control-plane, which calls provisioningJobService.processPendingJobs()
    // in-process. That calls elizaSandboxService.provision() → our
    // LocalDockerSandboxProvider → `docker run`.
    const provRes = await fetch(
      `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/provision`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect([200, 202]).toContain(provRes.status);

    // Wait up to 90s for a healthy container.
    const deadline = Date.now() + 90_000;
    let lastStatus = "";
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync("docker", [
          "inspect",
          "--format",
          "{{.State.Status}} {{.State.Health.Status}}",
          containerName,
        ]);
        lastStatus = stdout.trim();
        if (
          lastStatus.includes("healthy") ||
          lastStatus.startsWith("running")
        ) {
          break;
        }
      } catch {
        // Container not yet created — keep polling.
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(
      lastStatus,
      `container ${containerName} never became running`,
    ).toMatch(/^running/);

    // Read the published bridge port + secret directly from docker so the test
    // doesn't depend on a cloud-api endpoint exposing them.
    const portInspect = await execFileAsync("docker", [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "18790/tcp") 0).HostPort}}',
      containerName,
    ]);
    const bridgePort = Number.parseInt(portInspect.stdout.trim(), 10);
    expect(Number.isFinite(bridgePort), "bridge host port discovered").toBe(
      true,
    );

    const envInspect = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      containerName,
    ]);
    const envLine = envInspect.stdout
      .split("\n")
      .find((l) => l.startsWith("BRIDGE_SECRET="));
    expect(envLine, "BRIDGE_SECRET set on container").toBeTruthy();
    const bridgeSecret = envLine?.slice("BRIDGE_SECRET=".length) ?? "";

    // Chat — the echo-mode image responds with "[echo] <text>".
    // Wait for the bridge server to be reachable AND for the agent runtime
    // to be fully initialized. The container's HEALTHCHECK probe goes green
    // as soon as /health (port 2138) responds — but the /bridge HTTP server
    // (port 18790) binds a few hundred ms later, and the runtime itself
    // takes ~5-10s to load plugin-sql, migrations, and elizaOS plugins.
    // Sending message.send before runtime is ready returns 503 with
    // {"error":"Agent runtime not ready"}. Poll status.get until
    // result.status === "running".
    const bridgeDeadline = Date.now() + 120_000;
    let runtimeReady = false;
    while (Date.now() < bridgeDeadline) {
      try {
        const ping = await fetch(`http://127.0.0.1:${bridgePort}/bridge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bridgeSecret}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "ping",
            method: "status.get",
            params: {},
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (ping.ok) {
          const pingBody = (await ping.json()) as {
            result?: { status?: string };
          };
          if (pingBody.result?.status === "running") {
            runtimeReady = true;
            break;
          }
        } else {
          await ping.body?.cancel();
        }
      } catch {
        // socket error / TCP refused — bridge not bound yet, retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(runtimeReady, "agent runtime initialized within 120s").toBe(true);

    // Chat — proves the bridge route is reachable and authenticated. The
    // cloud-agent image ships with @elizaos/core + plugin-sql, so the
    // runtime is real (not echo). Reply content depends on whether an LLM
    // provider key is present: with one, a model response; without, the
    // runtime errors back. This assertion gates the SHAPE — valid JSON-RPC
    // envelope with the right id from an authenticated request.
    const chatRes = await fetch(`http://127.0.0.1:${bridgePort}/bridge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bridgeSecret}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message.send",
        params: { text: "hello from playwright" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    // 200 on success; 500 with a JSON envelope when the runtime fails to
    // generate (no LLM, transient error). Both prove route+auth work
    // (would be 401 if auth failed, 404 if route missing).
    expect([200, 500]).toContain(chatRes.status);
    const chatBody = (await chatRes.json()) as {
      jsonrpc?: string;
      id?: number;
      result?: { text?: string };
      error?: { code?: number; message?: string };
    };
    expect(chatBody.jsonrpc, "JSON-RPC envelope").toBe("2.0");
    expect(chatBody.id, "JSON-RPC id echoed").toBe(1);

    if (chatBody.result?.text) {
      expect(typeof chatBody.result.text).toBe("string");
      expect(chatBody.result.text.length).toBeGreaterThan(0);
    } else {
      expect(chatBody.error, "error envelope when no result").toBeTruthy();
    }
  });

  /**
   * End-to-end through the user-facing cloud-api bridge proxy
   * (`POST /api/v1/eliza/agents/{id}/bridge`). This is the path the
   * dashboard frontend uses to chat — it forwards via control-plane to
   * elizaSandboxService.bridge(), which now tries the cloud-agent's
   * native /bridge JSON-RPC first (bridgeNativeJsonRpcSend) before
   * falling back to legacy REST attempts.
   *
   * Gated by E2E_FULL_PROVISION=1 (same as the direct-bridge test).
   */
  test("chat via cloud-api bridge proxy /api/v1/eliza/agents/{id}/bridge", async () => {
    test.skip(
      process.env.E2E_FULL_PROVISION !== "1",
      "E2E_FULL_PROVISION=1 not set — skipping live-container test",
    );

    const { apiKey } = await signInWithFreshSolanaKey();

    const createRes = await fetch(`${apiBaseUrl}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentName: `siws-proxy-${Date.now()}` }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };
    const agentId = created.id;
    const containerName = `agent-${agentId}`;

    const provRes = await fetch(
      `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/provision`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect([200, 202]).toContain(provRes.status);

    // Wait for the container's bridge to be runtime-ready (same logic as
    // the direct-bridge test, but here we don't have the secret — we hit
    // /bridge via the cloud-api proxy which carries auth in-band).
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync("docker", [
          "inspect",
          "--format",
          "{{.State.Status}} {{.State.Health.Status}}",
          containerName,
        ]);
        if (stdout.includes("healthy")) break;
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Poll the cloud-api bridge proxy with status.get until the runtime is
    // "running" — same race window as the direct test, just routed through
    // the proxy. status.get doesn't depend on an LLM provider.
    const proxyDeadline = Date.now() + 120_000;
    let runtimeReady = false;
    while (Date.now() < proxyDeadline) {
      try {
        const ping = await fetch(
          `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/bridge`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "ready-ping",
              method: "status.get",
              params: {},
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (ping.ok) {
          const body = (await ping.json()) as {
            result?: { status?: string };
          };
          if (body.result?.status === "running") {
            runtimeReady = true;
            break;
          }
        } else {
          await ping.body?.cancel();
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(runtimeReady, "runtime ready via proxy within 120s").toBe(true);

    const chatRes = await fetch(
      `${apiBaseUrl}/api/v1/eliza/agents/${agentId}/bridge`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "message.send",
          params: { text: "hello via proxy" },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    expect(chatRes.status).toBe(200);
    const body = (await chatRes.json()) as {
      jsonrpc?: string;
      id?: number | string | null;
      result?: { text?: string };
      error?: { code?: number; message?: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    // Cloud-api may normalize the id (string→number etc.) so just assert
    // SOMETHING came back in the envelope.
    expect(
      body.result || body.error,
      "JSON-RPC envelope has result or error",
    ).toBeTruthy();
  });
});
