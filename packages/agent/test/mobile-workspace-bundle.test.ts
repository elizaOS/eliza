/** Compiles and executes workspace exports through the mobile source resolver. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

it("bundles unbuilt nested package exports into a runnable artifact without changing browser selection", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const output = testOutputPath("mobile-workspace-bundle");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, "case-"));
  try {
    const fixture = path.join(directory, "fixture");
    await mkdir(path.join(fixture, "src/nested"), { recursive: true });
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: "@fixture/platform",
        type: "module",
        exports: {
          ".": {
            "eliza-source": "./src/nested/node.ts",
            browser: "./src/index.browser.ts",
            import: "./dist/absent.js",
          },
        },
      }),
    );
    await writeFile(
      path.join(fixture, "src/nested/node.ts"),
      'export const platform = "native";',
    );
    await writeFile(
      path.join(fixture, "src/index.browser.ts"),
      'export const platform = "browser";',
    );
    await writeFile(
      path.join(directory, "entry.ts"),
      `
      import { platform } from "@fixture/platform";
      import { phoneDraftDefinition, validatePhoneSpec } from "@elizaos/plugin-workflow/services/phone-workflow-spec";
      const spec = validatePhoneSpec({version:1,name:"Bundled draft",description:"",trigger:{kind:"manual"},steps:[{id:"read",kind:"Read",operation:"supplied_text",text:"review me"}]});
      console.log(JSON.stringify({platform, draft:phoneDraftDefinition(spec)}));
    `,
    );
    await writeFile(
      path.join(directory, "browser.ts"),
      'import {platform} from "@fixture/platform"; import {LoginAuth} from "@elizaos/auth"; console.log(JSON.stringify({platform, loginBaseUrl: new LoginAuth({baseUrl:"https://login.example.test"}).getBaseUrl()}));',
    );
    await writeFile(
      path.join(directory, "build.ts"),
      `
      import {findWorkspaceSourceEntry} from ${JSON.stringify(path.join(root, "packages/agent/scripts/mobile-workspace-entry.ts"))};
      const target = process.argv[2];
      const packages = ${JSON.stringify({ "@fixture/platform": fixture, "@elizaos/core": path.join(root, "packages/core"), "@elizaos/auth": path.join(root, "packages/auth"), "@elizaos/plugin-workflow": path.join(root, "plugins/plugin-workflow") })};
      const result = await Bun.build({entrypoints:[${JSON.stringify(directory)}+"/"+(target === "browser" ? "browser.ts" : "entry.ts")],outdir:${JSON.stringify(directory)}+"/"+target,target,plugins:[{name:"mobile-source-entries",setup(build){build.onResolve({filter:/^@(?:elizaos|fixture)\\//},args=>{const parts=args.path.split("/");const dir=packages[parts.slice(0,2).join("/")];if(!dir)return;const entry=findWorkspaceSourceEntry(dir,parts.slice(2).join("/"),target);if(!entry)throw Error("Missing mobile export "+args.path);return {path:entry};});}}]});
      if(!result.success)throw new AggregateError(result.logs,"Bundle failed");
    `,
    );
    for (const target of ["bun", "browser"]) {
      execFileSync(
        "bun",
        ["--no-install", path.join(directory, "build.ts"), target],
        { cwd: root, stdio: "pipe" },
      );
      const result = JSON.parse(
        execFileSync(
          "bun",
          [
            "--no-install",
            path.join(
              directory,
              target,
              target === "browser" ? "browser.js" : "entry.js",
            ),
          ],
          { cwd: root, encoding: "utf8" },
        ),
      );
      expect(result.platform).toBe(target === "bun" ? "native" : "browser");
      if (target === "browser") {
        expect(result.loginBaseUrl).toBe("https://login.example.test");
      }
      if (target === "bun") {
        expect(result.draft.active).toBe(false);
        expect(result.draft.source).toContain("review me");
        expect(
          JSON.parse(result.draft.metadata.elizaPhoneWorkflowSpec).name,
        ).toBe("Bundled draft");
      }
    }
    await writeFile(
      path.join(directory, "outside.ts"),
      "export const escaped = true;",
    );
    await symlink(
      path.join(directory, "outside.ts"),
      path.join(fixture, "src/linked.ts"),
    );
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: "@fixture/platform",
        type: "module",
        exports: {
          "./escape": { "eliza-source": "../outside.ts" },
          "./linked": { "eliza-source": "./src/linked.ts" },
        },
      }),
    );
    for (const subpath of ["escape", "linked"]) {
      await writeFile(
        path.join(directory, "entry.ts"),
        `import {escaped} from "@fixture/platform/${subpath}"; console.log(escaped);`,
      );
      expect(() =>
        execFileSync(
          "bun",
          ["--no-install", path.join(directory, "build.ts"), "bun"],
          { cwd: root, stdio: "pipe" },
        ),
      ).toThrow(/Missing mobile export/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
