import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Exercise published bytes outside workspace source/export aliases. Build first. */
export function verifyPackedConsumer({
  packageRoot,
  fixtureDirectory,
  requiredFiles,
  sourcePrefixes = [],
  dependencies = [],
  compiler = resolve(import.meta.dirname, "../../../node_modules/.bin/tsc"),
}: {
  packageRoot: string;
  fixtureDirectory: string;
  requiredFiles: string[];
  sourcePrefixes?: string[];
  dependencies?: string[];
  compiler?: string;
}): void {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.match(manifest.name, /^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/);
  const require = createRequire(join(packageRoot, "package.json"));
  const temporary = mkdtempSync(
    join(tmpdir(), `eliza-${basename(packageRoot)}-package-`),
  );
  const run = (file: string, args: string[], cwd = packageRoot) =>
    execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    const packed = JSON.parse(
      run("npm", [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporary,
      ]),
    )[0];
    assert.equal(packed.filename, basename(packed.filename));
    const files: string[] = packed.files.map(
      (file: { path: string }) => file.path,
    );
    for (const file of files)
      assert(!file.startsWith("/") && !file.split("/").includes(".."));
    for (const required of requiredFiles)
      assert(files.includes(required), `Packed file missing: ${required}`);
    assert(
      !files.some(
        (file) => file.includes("/build/") || file.startsWith("test/"),
      ),
      "Build outputs or fixture sources shipped",
    );
    const modules = join(temporary, "node_modules"),
      destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    run("tar", [
      "-xzf",
      join(temporary, packed.filename),
      "--strip-components=1",
      "-C",
      destination,
    ]);
    for (const prefix of sourcePrefixes) {
      assert(
        prefix && !prefix.startsWith("/") && !prefix.split("/").includes(".."),
      );
      const tracked = run("git", ["ls-files", "-z", "--", prefix])
        .split("\0")
        .filter(Boolean);
      assert(tracked.length > 0, `No tracked source for ${prefix}`);
      for (const file of tracked) {
        assert(files.includes(file), `Native source missing: ${file}`);
        assert(
          readFileSync(join(destination, file)).equals(
            readFileSync(join(packageRoot, file)),
          ),
          `Packed source differs: ${file}`,
        );
      }
    }
    for (const dependency of dependencies) {
      assert.match(dependency, /^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/);
      const target = join(modules, dependency);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        dirname(require.resolve(`${dependency}/package.json`)),
        target,
        "junction",
      );
    }
    writeFileSync(
      join(temporary, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      }),
    );
    for (const file of ["consumer.ts", "runtime.mjs"])
      copyFileSync(join(fixtureDirectory, file), join(temporary, file));
    process.stdout.write(
      run(compiler, ["-p", join(temporary, "tsconfig.json")], temporary),
    );
    process.stdout.write(
      run(process.execPath, [join(temporary, "runtime.mjs")], temporary),
    );
    console.log(
      `${manifest.name}: packed external types, runtime exports and source bytes verified; no native execution`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
