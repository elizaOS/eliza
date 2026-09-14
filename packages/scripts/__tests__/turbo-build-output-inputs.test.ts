/**
 * Exercises Turbo's real input hashing for generated declarations and source edits.
 * A disposable workspace uses the repository build input/output contract without
 * invoking production package builds or changing the shared checkout.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

test("generated declaration changes do not invalidate source builds", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "eliza-turbo-inputs-"));
  try {
    const repository = JSON.parse(
      readFileSync(path.join(root, "turbo.json"), "utf8"),
    );
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "owned-turbo-input-control",
        private: true,
        packageManager: "bun@1.3.14",
        scripts: { build: "node --version" },
      }),
    );
    writeFileSync(
      path.join(directory, "turbo.json"),
      JSON.stringify({
        tasks: {
          build: {
            inputs: repository.tasks.build.inputs.filter(
              (input: string) => !input.startsWith("$TURBO_ROOT$/"),
            ),
            outputs: repository.tasks.build.outputs,
          },
        },
      }),
    );
    mkdirSync(path.join(directory, "src"));
    mkdirSync(path.join(directory, "dist"));
    const source = path.join(directory, "src/index.ts");
    const output = path.join(directory, "dist/index.d.ts");
    const config = path.join(directory, "tsconfig.json");
    writeFileSync(source, "export const value = 1;\n");
    writeFileSync(output, "export declare const value: number;\n");
    writeFileSync(config, "{}\n");
    function hash(): string {
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "node_modules/turbo/bin/turbo"),
          "run",
          "build",
          "--dry=json",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            TURBO_TELEMETRY_DISABLED: "1",
            GOMAXPROCS: "2",
          },
        },
      );
      if (result.error) throw result.error;
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.tasks).toHaveLength(1);
      return parsed.tasks[0].hash;
    }
    const initial = hash();
    writeFileSync(output, "export declare const value: string;\n");
    expect(hash()).toBe(initial);
    writeFileSync(source, "export const value = 2;\n");
    const changedSource = hash();
    expect(changedSource).not.toBe(initial);
    writeFileSync(config, '{"compilerOptions":{"strict":true}}\n');
    expect(hash()).not.toBe(changedSource);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);
