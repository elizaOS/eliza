/**
 * Real PGlite: an in-memory database started from an initdb snapshot keeps one
 * WebAssembly heap, answers queries and loads the bundled extensions; the plain
 * initdb path keeps two (PGlite 0.4.x retains its temporary initdb instance).
 * Each case runs in a Bun child process so heaps from one case cannot leak
 * into another's count.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manager = fileURLToPath(new URL("../pglite/manager.ts", import.meta.url));

function run(snapshot: string | null, makeSnapshot = false) {
  const script = `
    const Original = WebAssembly.Memory; const refs = [];
    WebAssembly.Memory = function (d) { const m = new Original(d); refs.push(new WeakRef(m)); return m; };
    WebAssembly.Memory.prototype = Original.prototype;
    const { PGliteClientManager } = await import(${JSON.stringify(manager)});
    const db = new PGliteClientManager({ dataDir: "memory://" });
    await db.initialize();
    const client = db.getConnection();
    const version = (await client.query("select version() as v")).rows[0].v;
    await client.query("create extension if not exists vector");
    await client.query("create extension if not exists pg_trgm");
    await client.query("create extension if not exists fuzzystrmatch");
    const vector = (await client.query("select '[1,2,3]'::vector as v")).rows[0].v;
    ${makeSnapshot ? `await Bun.write(${JSON.stringify(snapshot)}, await client.dumpDataDir("gzip"));` : ""}
    Bun.gc(true); await new Promise((r) => setTimeout(r, 200)); Bun.gc(true);
    const live = refs.map((r) => r.deref()).filter(Boolean).length;
    console.log(JSON.stringify({ version, vector, live }));
    process.exit(0);
  `;
  const env = { ...process.env };
  delete env.PGLITE_INITDB_SNAPSHOT;
  if (snapshot && !makeSnapshot) env.PGLITE_INITDB_SNAPSHOT = snapshot;
  // The child is Bun (Bun.gc, TypeScript import) whether vitest runs under Node or Bun.
  const bun = process.versions.bun ? process.execPath : "bun";
  const result = spawnSync(bun, ["--eval", script], { env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || `exit ${result.status}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as { version: string; vector: string; live: number };
}

describe("PGlite initdb snapshot", () => {
  it("starts an in-memory database with one WebAssembly heap instead of two", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pglite-snapshot-"));
    try {
      const snapshot = path.join(dir, "pglite-initdb.bin");
      // The first run takes the plain initdb path and writes its cluster as the snapshot.
      const plain = run(snapshot, true);
      expect(plain.live).toBeGreaterThanOrEqual(2);
      const fromSnapshot = run(snapshot);
      expect(fromSnapshot.live).toBe(1);
      expect(fromSnapshot.version).toBe(plain.version);
      expect(fromSnapshot.vector).toBe("[1,2,3]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
