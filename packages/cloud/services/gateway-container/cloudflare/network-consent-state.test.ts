import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudflareNetworkConsentLedger,
  type NetworkConsentEntry,
} from "@elizaos/cloud-services-common/network-consent";
import { Miniflare } from "miniflare";

let worker: Miniflare;
let directory: string;
let script: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      NETWORK_CONSENT_STATE: {
        className: "NetworkConsentState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected external consent I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "network-consent-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "network-consent.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Consent fixture build failed");
  const output = build.outputs[0];
  if (!output) throw new Error("No consent fixture output");
  script = await output.text();
  worker = start();
  await worker.ready;
}, 60_000);
afterAll(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const entry = (
  state: NetworkConsentEntry["state"],
  at: string,
  app?: NetworkConsentEntry["app"],
): NetworkConsentEntry => ({
  project: "project",
  address: "person",
  channel: "twilio",
  source: "keyword",
  state,
  at,
  app,
});
const call = (input: object, path = "/private", token = "test-only") =>
  worker.dispatchFetch(`https://consent.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
const ledger = () =>
  cloudflareNetworkConsentLedger(
    {
      NETWORK_CONSENT_URL: "https://consent.test/internal/network-consent",
      NETWORK_CONSENT_TOKEN: "test-only",
    },
    async (url, init) => {
      if (typeof init.body !== "string")
        throw new Error("Expected JSON request");
      const response = await worker.dispatchFetch(String(url), {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    },
  );

test("quiesced import preserves full history, rejects conflicts, and seals permanently on serving", async () => {
  const history = Array.from({ length: 201 }, (_, i) =>
    entry(
      "opted_out",
      new Date(Date.UTC(2026, 0, 1, 0, 0, 201 - i)).toISOString(),
    ),
  );
  const current = history[0];
  const input = {
    operation: "import",
    project: "project",
    address: "person",
    sourceQuiesced: true,
    current: [current],
    history,
  };
  expect((await call({ ...input, sourceQuiesced: false })).status).toBe(400);
  expect((await call(input)).status).toBe(200);
  expect((await call(input)).status).toBe(200);
  expect((await call({ ...input, history: [] })).status).toBe(409);
  expect(
    await (
      await call({
        operation: "history",
        project: "project",
        address: "person",
      })
    ).json(),
  ).toEqual(history);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect(await ledger().current("project", " Person ")).toEqual(current);
  expect((await call(input)).status).toBe(409);
  expect(
    (await call({ operation: "current", project: "other", address: "person" }))
      .status,
  ).toBe(403);
});

test("concurrent timestamp ties preserve STOP, app isolation, and persistence", async () => {
  const at = "2026-02-01T00:00:00.000Z";
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      ledger().record(entry(i % 2 ? "opted_out" : "opted_in", at)),
    ),
  );
  await ledger().record(entry("opted_in", "2026-01-01T00:00:00.000Z"));
  await ledger().record(entry("opted_in", at, "ntwrk"));
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await ledger().current("project", "person"))?.state).toBe(
    "opted_out",
  );
  expect((await ledger().current("project", "person", "ntwrk"))?.state).toBe(
    "opted_in",
  );
  expect(await ledger().current("other", "person")).toBeNull();
  expect(await ledger().current("project", "different")).toBeNull();
  const response = await call({
    operation: "history",
    project: "project",
    address: "person",
  });
  expect(((await response.json()) as unknown[]).length).toBe(200);
});

test("public transport rejects unauthenticated and private operations", async () => {
  const input = { operation: "current", project: "project", address: "person" };
  expect((await call(input, "/internal/network-consent", "wrong")).status).toBe(
    401,
  );
  expect(
    (await call({ ...input, app: ["ntwrk"] }, "/internal/network-consent"))
      .status,
  ).toBe(400);
  for (const operation of ["import", "history"])
    expect(
      (await call({ ...input, operation }, "/internal/network-consent")).status,
    ).toBe(400);
  expect(
    (await call({ ...input, app: "invalid" }, "/internal/network-consent"))
      .status,
  ).toBe(400);
  expect(
    (
      await call(
        {
          operation: "record",
          project: "project",
          address: "person",
          entry: {
            ...entry("opted_in", "2026-03-01T00:00:00Z"),
            project: "foreign",
          },
        },
        "/internal/network-consent",
      )
    ).status,
  ).toBe(400);
});
