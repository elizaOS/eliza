import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

const db = await PGlite.create({
  dataDir: "/home/milady/iqlabs/pglite-snapshot",
  extensions: { vector, fuzzystrmatch },
});
const sizes = await db.query(`
  SELECT relname, pg_total_relation_size(c.oid) AS bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY 2 DESC LIMIT 12`);
for (const r of sizes.rows as { relname: string; bytes: string | number }[])
  console.log(`${r.relname}: ${(Number(r.bytes) / 1048576).toFixed(0)} MB`);
console.log("-- schema-only dump --");
const file = await pgDump({ pg: db, args: ["--schema-only", "--no-owner", "--no-privileges"] });
await Bun.write("/home/milady/iqlabs/eliza-schema.sql", file);
console.log("schema dump bytes:", (await file.arrayBuffer()).byteLength);
await db.close();
