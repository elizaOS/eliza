/**
 * Seed helper for audit-credit-packs.proof.test.ts — inserts rows into the
 * PGlite store at argv[2] from the JSON rows file at argv[3]. Runs as its own
 * process so the db client binds to the target store, not a cached one.
 */
const [dbUrl, rowsFile] = process.argv.slice(2);
if (!dbUrl || !rowsFile) {
  console.error("usage: audit-credit-packs.seed.ts <DATABASE_URL> <rows.json>");
  process.exit(2);
}
process.env.DATABASE_URL = dbUrl;
process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";

const rows = JSON.parse(await Bun.file(rowsFile).text());
const { db } = await import("../../shared/src/db/client");
const { creditPacks } = await import(
  "../../shared/src/db/schemas/credit-packs"
);
await db.insert(creditPacks).values(rows);
console.log(`seeded ${rows.length} pack(s)`);
process.exit(0);
