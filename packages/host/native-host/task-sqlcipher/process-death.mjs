import { readFile } from "node:fs/promises";
import { createSqlCipherTaskProvider } from "../task-sqlcipher.mjs";
import { openTaskDatabase } from "../task-storage.mjs";

const [buildPath, path] = process.argv.slice(2);
const build = JSON.parse(await readFile(buildPath, "utf8"));
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { key, canary } = JSON.parse(input);
const db = await openTaskDatabase({
  databasePath: path,
  requireEncryption: true,
  databaseProvider: createSqlCipherTaskProvider({
    libraryPath: build.library,
    sha256: build.sha256,
    machine: build.machine,
    libraryMode: "private-snapshot",
    resolveKey: () => new Uint8Array(key),
  }),
});
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT)");
db.prepare("INSERT INTO records VALUES (?)").run(canary);
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE records SET value=?").run("uncommitted");
console.log("READY");
setInterval(() => {}, 1000);
