// Synthetic host qualification only. No real credentials or keys in arguments.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSqlCipherTaskProvider } from "../task-sqlcipher.mjs";
import { spawnTestRuntime } from "./test-runtime.mjs";

const [mode, buildPath, path] = process.argv.slice(2);
if (mode === "broker") {
  const writer = spawnTestRuntime(
    [fileURLToPath(import.meta.url), "writer", buildPath, path],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  writer.stdout.pipe(process.stdout);
  setInterval(() => {}, 1000);
} else {
  const build = JSON.parse(await readFile(buildPath, "utf8"));
  const db = await createSqlCipherTaskProvider({
    libraryPath: build.library,
    sha256: build.sha256,
    machine: build.machine,
    libraryMode: "private-snapshot",
    resolveKey: () => new Uint8Array(32).fill(19),
  }).open({ path });
  db.exec("CREATE TABLE IF NOT EXISTS lease_test(value INTEGER)");
  if (mode === "exec-child") {
    const child = spawnTestRuntime(["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    console.log(`EXEC_CHILD ${child.pid}`);
    // Deliberately exit without DB close: the exec child must not retain the lease.
    process.exit(0);
  }
  console.log(`READY ${process.pid}`);
  setInterval(() => {}, 1000);
}
