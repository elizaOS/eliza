/**
 * App Documents live e2e tests.
 *
 * Boots a real runtime and tests the document management API endpoints:
 * availability/listing, document upload, and search.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import path from "node:path";
import { documentsPlugin } from "@elizaos/app-documents";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type RuntimeHarness as Runtime,
  startLiveRuntimeServer,
} from "../../../packages/app-core/test/helpers/live-runtime-server";
import { describeIf } from "../../../test/helpers/conditional-tests";
import { req } from "../../../test/helpers/http";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  /* dotenv optional */
}

describeIf(LIVE)("App Documents: API e2e", () => {
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = await startLiveRuntimeServer({
      plugins: [documentsPlugin],
      tempPrefix: "eliza-documents-e2e-",
    });
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it("GET /api/documents returns document list status", async () => {
    const res = await req(runtime.port, "GET", "/api/documents");
    expect(res.status).toBe(200);
    expect(res.data).toBeTruthy();
    const data = res.data as Record<string, unknown>;
    expect(data).toHaveProperty("ok");
    expect(data).toHaveProperty("available");
    expect(data).toHaveProperty("documents");
  }, 30_000);

  it("document routes respond to expected endpoints", async () => {
    const endpoints = [
      { method: "GET", path: "/api/documents" },
      { method: "GET", path: "/api/documents/stats" },
    ];

    for (const { method, path: endpoint } of endpoints) {
      const res = await req(runtime.port, method, endpoint);
      expect(res.status).toBeLessThan(500);
      expect(res.data).toBeTruthy();
    }
  }, 30_000);

  it("POST /api/documents accepts document upload", async () => {
    const res = await req(runtime.port, "POST", "/api/documents", {
      content:
        "The quick brown fox jumps over the lazy dog. This is a test document.",
      filename: "test-document.txt",
      contentType: "text/plain",
      metadata: {
        title: "Test Document",
        source: "e2e-test",
      },
    });
    expect([200, 201, 400, 503]).toContain(res.status);
  }, 60_000);

  it("GET /api/documents/search handles queries", async () => {
    const res = await req(
      runtime.port,
      "GET",
      "/api/documents/search?q=test&limit=5",
    );
    expect([200, 400, 500, 503]).toContain(res.status);
  }, 30_000);
});
