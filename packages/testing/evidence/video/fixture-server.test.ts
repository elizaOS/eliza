/** Exercises a real local fixture server through valid requests, rejected paths and recovery. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serveFixture } from "./fixture-server.ts";

type FixtureFetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

const fixtureFetch = fetch as unknown as (
  input: string | URL,
) => Promise<FixtureFetchResponse>;

const dir = mkdtempSync(join(os.tmpdir(), "evidence-fixture-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serveFixture", () => {
  it("serves fixture files, denies invalid paths and survives malformed requests", async () => {
    const root = mkdtempSync(join(dir, "root-"));
    writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(root, "data.json"), '{"ok":true}');
    writeFileSync(join(dir, "outside.txt"), "outside-root-sentinel");
    const server = await serveFixture(root);
    try {
      const index = await fixtureFetch(server.baseUrl);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("hi");

      const data = await fixtureFetch(new URL("data.json", server.baseUrl));
      expect(data.status).toBe(200);
      expect(data.headers.get("content-type")).toContain("application/json");
      expect(await data.text()).toBe('{"ok":true}');
      expect(
        (await fixtureFetch(new URL("nope.txt", server.baseUrl))).status,
      ).toBe(404);

      const traversal = await fixtureFetch(
        `${server.baseUrl}%2e%2e%2foutside.txt`,
      );
      expect(traversal.status).toBe(403);
      expect(await traversal.text()).not.toContain("outside-root-sentinel");
      expect((await fixtureFetch(`${server.baseUrl}%`)).status).toBe(400);
      const recovered = await fixtureFetch(server.baseUrl);
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("hi");
    } finally {
      await server.stop();
    }
  });
});
