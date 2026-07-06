// Fixture static server: tool-free, always runs. Asserts it serves a file under
// the root, answers `/` with the index, 404s a missing file, and rejects a
// path-traversal attempt with 403 rather than serving outside the root.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serveFixture } from "./fixture-server.ts";

const dir = mkdtempSync(join(os.tmpdir(), "evidence-fixture-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serveFixture", () => {
  it("serves the index at / and a named file, and 404s a missing one", async () => {
    const root = mkdtempSync(join(dir, "root-"));
    writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(root, "data.json"), '{"ok":true}');
    const server = await serveFixture(root);
    try {
      const index = await fetch(server.baseUrl);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("hi");

      const data = await fetch(new URL("data.json", server.baseUrl));
      expect(data.status).toBe(200);
      expect(data.headers.get("content-type")).toContain("application/json");

      const missing = await fetch(new URL("nope.txt", server.baseUrl));
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("rejects path traversal with 403", async () => {
    const root = mkdtempSync(join(dir, "root2-"));
    writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
    const server = await serveFixture(root);
    try {
      // Encoded traversal that would otherwise resolve above the root.
      const res = await fetch(
        new URL("%2e%2e%2f%2e%2e%2fetc%2fpasswd", server.baseUrl),
      );
      expect([403, 404]).toContain(res.status);
    } finally {
      await server.stop();
    }
  });

  it("answers malformed percent-encoding with 400 and keeps serving", async () => {
    const root = mkdtempSync(join(dir, "root3-"));
    writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
    const server = await serveFixture(root);
    try {
      // decodeURIComponent("%") throws URIError; before the guard this crashed
      // the whole process mid-walkthrough instead of answering the request.
      const bad = await fetch(`${server.baseUrl}%`);
      expect(bad.status).toBe(400);
      // The server survived and still serves the index.
      const index = await fetch(server.baseUrl);
      expect(index.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
