/** A local entry cannot certify foreign transitive workspace code. */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("rejects a foreign SQL-to-core resolution even when the worker entry is local", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "gepa-source-graph-")),
  );
  const checkout = join(directory, "owned");
  const foreign = join(directory, "foreign-core");
  try {
    await mkdir(join(checkout, "node_modules", "@elizaos"), {
      recursive: true,
    });
    await mkdir(foreign);
    await writeFile(join(checkout, "worker.ts"), 'import "./sql.ts";');
    await writeFile(join(checkout, "sql.ts"), 'import "@elizaos/core";');
    await writeFile(
      join(foreign, "package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        exports: "./index.ts",
        type: "module",
      }),
    );
    await writeFile(join(foreign, "index.ts"), "export const foreign = true;");
    await symlink(foreign, join(checkout, "node_modules", "@elizaos", "core"));
    const helper = fileURLToPath(
      new URL("./gepa-source-proof.ts", import.meta.url),
    );
    const program = `
      import { inspectGepaWorkspaceSources } from ${JSON.stringify(helper)};
      const checkout = ${JSON.stringify(checkout)};
      const worker = Bun.resolveSync("./worker.ts", checkout);
      if (!worker.startsWith(checkout + "/")) throw new Error("fixture entry is foreign");
      try {
        await inspectGepaWorkspaceSources(checkout, [worker], new Set(["worker.ts", "sql.ts"]));
        throw new Error("foreign dependency accepted");
      } catch (error) {
        if (!String(error).includes("outside the checkout") || !String(error).includes("sql.ts -> @elizaos/core")) throw error;
        console.log("local entry, foreign nested core rejected");
      }
    `;
    const output = execFileSync(
      "bun",
      ["--conditions=eliza-source", "-e", program],
      { cwd: directory, encoding: "utf8" },
    );
    expect(output).toContain("local entry, foreign nested core rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
