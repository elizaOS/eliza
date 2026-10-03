import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "package.json"));
const temporary = mkdtempSync(join(tmpdir(), "eliza-reminders-package-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" },
    ),
  )[0];
  const files = packed.files.map((file) => file.path);
  for (const required of [
    "dist/android.js",
    "dist/android.d.ts",
    "src/android.ts",
    "android/src/main/java/ai/eliza/plugins/reminders/ReminderPlugin.java",
  ])
    assert(files.includes(required), required);
  assert(
    !files.some((path) => path.includes("/build/") || path.startsWith("test/")),
  );
  const modules = join(temporary, "node_modules");
  const destination = join(modules, "@elizaos", "macosreminders");
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(temporary, packed.filename),
    "--strip-components=1",
    "-C",
    destination,
  ]);
  mkdirSync(join(modules, "@capacitor"), { recursive: true });
  symlinkSync(
    dirname(require.resolve("@capacitor/core/package.json")),
    join(modules, "@capacitor/core"),
  );
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
        skipLibCheck: true,
      },
      include: ["consumer.ts"],
    }),
  );
  for (const file of ["consumer.ts", "runtime.mjs"])
    copyFileSync(join(here, file), join(temporary, file));
  const tsc =
    process.env.REMINDERS_TSC || resolve(root, "../../node_modules/.bin/tsc");
  execFileSync(tsc, ["-p", join(temporary, "tsconfig.json")], {
    stdio: "inherit",
  });
  execFileSync(process.execPath, [join(temporary, "runtime.mjs")], {
    stdio: "inherit",
  });
  console.log("Packed external NodeNext type contracts passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
