import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

const db = await PGlite.create({
  dataDir: "/home/milady/iqlabs/pglite-snapshot",
  extensions: { vector, fuzzystrmatch },
});
const t0 = Date.now();
const file = await pgDump({
  pg: db,
  args: [
    "--no-owner", "--no-privileges",
    "--exclude-table-data", "trajectory_steps",
    "--exclude-table-data", "logs",
    "--exclude-table-data", "cache",
  ],
});
const buf = await file.arrayBuffer();
await Bun.write("/home/milady/iqlabs/eliza-full.sql", buf);
console.log(`dump ok: ${(buf.byteLength / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await db.close();
