/** Exercises the actual control/session/process transport; model fixtures are deliberately empty. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScenarioStabilitySubprocessAdapter } from "../../scenario-runner/src/stability-subprocess-adapter.ts";
import { createSyntheticControlHandler } from "../../src/synthetic-control/index.ts";
import { createSyntheticWorldControlAuthority } from "../src/control-authority.ts";
import { SqliteSyntheticEnvironmentLeaseStore } from "../src/sqlite-lease-store.ts";

const child = `
import { createHash } from "node:crypto";
import { createDeterministicModelFixtureRegistry } from ${JSON.stringify(new URL("../../src/deterministic-model-plugin.ts", import.meta.url).href)};
const fixtures = createDeterministicModelFixtureRegistry([]);
fixtures.assertConsumed();
const diagnostics = fixtures.diagnostics();
const endpoints = JSON.parse(process.env.ELIZA_SCENARIO_WORLD_ENDPOINTS);
if (process.env.ELIZA_SYNTHETIC_WORLD_LEASED !== "1") throw new Error("Missing leased world settings");
const before = await fetch(endpoints.slack + "/__mock/requests").then(r => r.json());
if (before.requests.length) throw new Error("Prior attempt leaked into world");
const response = await fetch(endpoints.slack + "/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "C001", text: "child mutation" }) });
if (!response.ok) throw new Error("Slack mutation failed");
const receipt = await response.json();
if (!receipt.ok) throw new Error("Slack rejected mutation");
const after = await fetch(endpoints.slack + "/__mock/requests").then(r => r.json());
process.stdout.write(JSON.stringify({ passed: true, initialStateHash: process.env.ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH, finalStateHash: createHash("sha256").update(JSON.stringify(after)).digest("hex"), inputTokens: 0, outputTokens: 0, toolCalls: 1, evidence: { trajectory: [], toolReceipts: [receipt], stateTransitions: after.requests, providerReceipts: [{ fixtureMode: "strict-fixtures", fixtureManifestFingerprint: createHash("sha256").update(JSON.stringify([])).digest("hex"), unmatchedCalls: diagnostics.unexpectedCalls.length, ambiguousCalls: diagnostics.unexpectedCalls.length, unusedRequiredFixtures: diagnostics.fixtures.filter(f => f.consumed < f.min).length, overconsumedFixtures: diagnostics.fixtures.filter(f => typeof f.max === "number" && f.consumed > f.max).length }], judgeVerdicts: [] }, stateDiff: { before, after } }));
`;

test("real subprocess attempts receive leased endpoints and reset actual API state", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "subprocess-world-")),
  );
  const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
    path.join(directory, "leases.sqlite"),
  );
  const namespace = "subprocess-world";
  const authority = createSyntheticWorldControlAuthority({
    namespace,
    leaseStore,
  });
  const token = "subprocess-world-test-token";
  const handler = createSyntheticControlHandler({
    namespace,
    token,
    authority,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await handler(request)) ?? new Response("missing", { status: 404 }),
  });
  const adapter = new ScenarioStabilitySubprocessAdapter({
    command: process.execPath,
    args: () => ["--conditions=eliza-source", "-e", child],
    cwd: directory,
    modelMode: {
      kind: "deterministic-mock",
      fixtureManifestFingerprint: createHash("sha256")
        .update(JSON.stringify([]))
        .digest("hex"),
    },
    syntheticControl: {
      controlUrl: server.url.origin,
      controlToken: token,
      manifest: {
        version: 1,
        namespace,
        manifestId: "empty-slack-v1",
        domains: { slack: {} },
      },
    },
  });
  let firstHash: string | undefined;
  try {
    for (const attemptNumber of [1, 2] as const) {
      const input = {
        target: {
          scenarioId: "transport",
          model: { provider: "deterministic", model: "empty-fixtures" },
        },
        attemptNumber,
        attemptId: `attempt-${attemptNumber}`,
        outputDir: path.join(directory, `attempt-${attemptNumber}`),
        budgets: {
          timeoutMs: 60_000,
          maxInputTokens: 0,
          maxOutputTokens: 0,
          maxToolCalls: 1,
        },
        signal: AbortSignal.timeout(60_000),
      };
      try {
        const result = await adapter.execute(input);
        expect(result.passed).toBe(true);
        expect(result.evidence.stateTransitions).toEqual([
          expect.objectContaining({
            method: "POST",
            path: "/api/chat.postMessage",
            body: { channel: "C001", text: "child mutation" },
          }),
        ]);
        if (firstHash) expect(result.initialStateHash).toBe(firstHash);
        firstHash = result.initialStateHash;
      } finally {
        await adapter.terminate({
          ...input,
          signal: AbortSignal.timeout(30_000),
        });
      }
      expect((await leaseStore.read(namespace))?.status).toBe("released");
    }
  } finally {
    await authority.close();
    await server.stop(true);
    leaseStore.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
