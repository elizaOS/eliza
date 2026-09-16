/**
 * Exercises optional plugin entrypoint selection in real Node and Bun processes.
 * Installed package metadata must distinguish absent exports from broken targets
 * before the host considers a barrel fallback.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["node", "bun"])(
  "%s preserves optional entrypoint boundaries",
  async (executable) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "app-module-runtime-"),
    );
    const scope = `@app-module-${path.basename(root).toLowerCase()}`;
    const packageRoot = fileURLToPath(
      new URL(`../../node_modules/${scope}/`, import.meta.url),
    );
    const cases = [
      { name: "absent", expected: null },
      { name: "invalid-manifest", expected: "APP_MODULE_RESOLUTION_FAILED" },
      {
        name: "unexported",
        exports: { ".": "./index.js" },
        expected: "fallback",
      },
      {
        name: "disabled",
        exports: { ".": "./index.js", "./plugin": null },
        expected: "fallback",
      },
      { name: "legacy", expected: "fallback" },
      {
        name: "valid",
        exports: { ".": "./index.js", "./plugin": "./plugin.js" },
        source: 'export default { name: "selected" };',
        expected: "selected",
      },
      {
        name: "missing-target",
        exports: { ".": "./index.js", "./plugin": "./missing.js" },
        expected: "APP_MODULE_LOAD_FAILED",
      },
      {
        name: "missing-pattern-target",
        exports: { ".": "./index.js", "./*": "./missing/*.js" },
        expected: "APP_MODULE_LOAD_FAILED",
      },
      {
        name: "disabled-exact-pattern",
        exports: {
          ".": "./index.js",
          "./*": "./missing/*.js",
          "./plugin": null,
        },
        expected: "fallback",
      },
      {
        name: "disabled-specific-pattern",
        exports: {
          ".": "./index.js",
          "./*": "./missing/*.js",
          "./plug*": null,
        },
        expected: "fallback",
      },
      {
        name: "missing-conditional-target",
        exports: { ".": "./index.js", "./plugin": { import: "./missing.js" } },
        expected: "APP_MODULE_LOAD_FAILED",
      },
      {
        name: "transitive",
        exports: { ".": "./index.js", "./plugin": "./plugin.js" },
        source: 'import "./missing-dependency.js";',
        expected: "APP_MODULE_LOAD_FAILED",
      },
      {
        name: "evaluation",
        exports: { ".": "./index.js", "./plugin": "./plugin.js" },
        source: 'throw new Error("initialization failed");',
        expected: "APP_MODULE_LOAD_FAILED",
      },
    ];
    try {
      for (const fixture of cases) {
        if (fixture.name === "absent") continue;
        const directory = path.join(packageRoot, fixture.name);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
          path.join(directory, "package.json"),
          fixture.name === "invalid-manifest"
            ? "{broken"
            : JSON.stringify({
                name: `${scope}/${fixture.name}`,
                type: "module",
                main: "./index.js",
                exports: fixture.exports,
              }),
        );
        await fs.writeFile(
          path.join(directory, "index.js"),
          'export default { name: "fallback" };',
        );
        if (fixture.source)
          await fs.writeFile(path.join(directory, "plugin.js"), fixture.source);
      }
      const runner = path.join(root, "run.mjs");
      await fs.writeFile(
        runner,
        `
      import { importAppPlugin } from ${JSON.stringify(new URL("./app-package-modules.ts", import.meta.url).href)};
      const result = {};
      for (const name of ${JSON.stringify(cases.map((fixture) => fixture.name))}) {
        try { result[name] = (await importAppPlugin(${JSON.stringify(scope)} + "/" + name))?.name ?? null; }
        catch (error) { result[name] = error.code; }
      }
      console.log(JSON.stringify(result));
    `,
      );
      const output = execFileSync(
        executable,
        [
          ...(executable === "bun"
            ? ["--no-install"]
            : ["--experimental-transform-types"]),
          runner,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            ELIZA_WORKSPACE_ROOT: root,
            ELIZA_STATE_DIR: path.join(root, "state"),
          },
        },
      );
      expect(
        JSON.parse(output.trim().slice(output.trim().lastIndexOf("\n") + 1)),
      ).toEqual(
        Object.fromEntries(
          cases.map((fixture) => [fixture.name, fixture.expected]),
        ),
      );
    } finally {
      await fs.rm(packageRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
