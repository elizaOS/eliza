/**
 * The operator attestation route over a real guest-v1 Unix socket: the
 * operator nonce is domain-separated into report data, only raw evidence is
 * returned, and missing configuration or guest failures are explicit errors.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  dstackOperatorAttestationRoute,
  dstackOperatorReportData,
} from "../src/api/tee-attestation-routes.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step();
});

function call(body: unknown) {
  const handler = dstackOperatorAttestationRoute.routeHandler;
  if (!handler) throw new Error("route has no handler");
  const ctx: RouteHandlerContext = {
    signal: new AbortController().signal,
    body,
    params: {},
    query: {},
    headers: {},
    method: "POST",
    path: dstackOperatorAttestationRoute.path,
    runtime: {} as IAgentRuntime,
    inProcess: false,
  };
  return handler(ctx);
}

async function guestSocket(status = 200) {
  const dir = await mkdtemp(path.join(tmpdir(), "dstack-guest-"));
  const socketPath = path.join(dir, "dstack.sock");
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ attestation: "0badc0de" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  vi.stubEnv(
    "ELIZA_DSTACK_EVIDENCE_CONFIG_JSON",
    JSON.stringify({
      socketPath,
      verifierPath: "/opt/dstack/dstack-verifier",
      verifierSha256: "a".repeat(64),
      verifierConfigPath: "/opt/dstack/dstack-verifier.toml",
      verifierConfigSha256: "b".repeat(64),
      appId: "c".repeat(40),
      composeHash: "d".repeat(64),
      osImageHash: "e".repeat(64),
      variant: "dstack-tdx",
    }),
  );
  vi.stubEnv("ELIZA_TEE_PRODUCTION_PROFILE", "");
  return requests;
}

it("returns raw guest evidence bound to the operator nonce", async () => {
  const requests = await guestSocket();
  const nonce = "1".repeat(64);
  const reportData = dstackOperatorReportData(nonce);
  expect(reportData).not.toBe(nonce);
  expect(await call({ nonce })).toEqual({
    status: 200,
    body: { nonce, reportData, attestation: "0badc0de" },
  });
  expect(requests).toEqual([
    { method: "POST", url: "/v1/Attest", body: { report_data: reportData } },
  ]);
});

it("rejects malformed nonces and reports unavailable evidence", async () => {
  vi.stubEnv("ELIZA_DSTACK_EVIDENCE_CONFIG_JSON", undefined);
  expect(await call({ nonce: "1".repeat(64) })).toEqual({
    status: 404,
    body: { error: "TEE_DSTACK_NOT_CONFIGURED" },
  });
  const requests = await guestSocket(503);
  expect((await call({ nonce: "short" })).status).toBe(400);
  expect((await call({ nonce: "A".repeat(64) })).status).toBe(400);
  expect(await call({ nonce: "2".repeat(64) })).toEqual({
    status: 502,
    body: { error: "TEE_DSTACK_ATTESTATION_UNAVAILABLE" },
  });
  expect(requests).toHaveLength(1);
});
