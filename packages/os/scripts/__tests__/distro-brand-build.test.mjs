import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  BrandConfigurationError,
  loadBrandConfig,
} from "../distro-android/brand-config.mjs";
import {
  AospCommandError,
  cuttlefishLaunchCommand,
  parseSubArgs,
  rebuildPrivilegedApk,
} from "../distro-android/build-aosp.mjs";
import { resolveElizaSourceRoot } from "../eliza-source.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const original = JSON.parse(
  readFileSync(
    new URL("../distro-android/brand.eliza.json", import.meta.url),
    "utf8",
  ),
);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "distro-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "brand' $(false).json");
  const save = (value) => writeFileSync(config, JSON.stringify(value));
  return { directory, config, save };
}

test("brand commands require an executable and literal argument array", (t) => {
  const { config, save } = fixture(t);
  for (const command of [
    "bun run build",
    [],
    [""],
    ["node", 1],
    ["node", "bad\0argument"],
  ]) {
    save({ ...original, buildAndroidSystemCmd: command });
    assert.throws(
      () => loadBrandConfig(config),
      (error) =>
        error instanceof BrandConfigurationError &&
        error.code === "ELIZAOS_BRAND_CONFIG_ERROR" &&
        /executable and literal string arguments/.test(error.message),
    );
  }
  save({
    ...original,
    buildAndroidSystemCmd: ["node", "", "space and ; shell syntax"],
  });
  assert.deepEqual(loadBrandConfig(config).buildAndroidSystemCmd, [
    "node",
    "",
    "space and ; shell syntax",
  ]);
});

test("APK build uses retained source selection, AOSP environment and exact argv without a shell", (t) => {
  const { directory, config, save } = fixture(t);
  const output = join(directory, "arguments.json");
  const sentinel = join(directory, "must-not-exist");
  const args = ["two words", "", `$(touch ${sentinel})`, "'quoted'; false"];
  save({
    ...original,
    buildAndroidSystemCmd: [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),app:process.env.ELIZA_APP_ID,aosp:process.env.ELIZA_AOSP_BUILD,gradle:process.env.ELIZA_GRADLE_AOSP_BUILD}))',
      output,
      ...args,
    ],
  });
  rebuildPrivilegedApk(loadBrandConfig(config));
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    args,
    cwd: resolveElizaSourceRoot(),
    app: original.packageName,
    aosp: "1",
    gradle: "true",
  });
  assert.equal(existsSync(sentinel), false);
  save({
    ...original,
    buildAndroidSystemCmd: [process.execPath, "-e", "process.exit(23)"],
  });
  assert.throws(
    () => rebuildPrivilegedApk(loadBrandConfig(config)),
    /exited with code 23/,
  );
});

test("CI brand resolution treats paths as data and refuses multiline action outputs", (t) => {
  const { directory, config, save } = fixture(t);
  const workflow = parse(
    readFileSync(
      join(root, "../../.github/workflows/elizaos-cuttlefish.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs["build-and-validate"].steps;
  const script = steps.find((step) => step.id === "brand").run;
  const output = join(directory, "outputs");
  const run = () =>
    spawnSync("bash", ["-e", "-c", script], {
      cwd: root,
      env: { ...process.env, BRAND_CONFIG: config, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
  save(original);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(output, "utf8"),
    /inference-targets=android-arm64-cpu-fused android-x86_64-cpu-fused\n/,
  );
  assert.doesNotMatch(readFileSync(output, "utf8"), /build-cmd=/);
  rmSync(output);
  save({ ...original, distroName: "name\ninjected=value" });
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(output), false);
  const build = steps.find((step) =>
    step.name?.startsWith("Build privileged APK"),
  );
  assert.match(
    build.run,
    /rebuildPrivilegedApk\(loadBrandConfig\(process.env.BRAND_CONFIG\)\)/,
  );
  for (const step of steps)
    assert.doesNotMatch(step.run ?? "", /\$\{\{ inputs\./);
});

test("APK subprocess errors retain spawn errors, exit codes, and termination signals", (t) => {
  const { directory, config, save } = fixture(t);
  const missing = join(directory, "missing-builder");
  save({ ...original, buildAndroidSystemCmd: [missing] });
  assert.throws(
    () => rebuildPrivilegedApk(loadBrandConfig(config)),
    (error) => {
      assert.ok(error instanceof AospCommandError);
      assert.equal(error.code, "ELIZAOS_AOSP_COMMAND_ERROR");
      assert.equal(error.command, missing);
      assert.equal(error.cause.code, "ENOENT");
      return true;
    },
  );
  for (const [program, exitCode, signal] of [
    ["process.exit(23)", 23, null],
    ['process.kill(process.pid, "SIGTERM")', null, "SIGTERM"],
  ]) {
    save({
      ...original,
      buildAndroidSystemCmd: [process.execPath, "-e", program],
    });
    assert.throws(
      () => rebuildPrivilegedApk(loadBrandConfig(config)),
      (error) => {
        assert.ok(error instanceof AospCommandError);
        assert.equal(error.exitCode, exitCode);
        assert.equal(error.signal, signal);
        if (signal) assert.match(error.message, /terminated by SIGTERM/);
        return true;
      },
    );
  }
});

test("AOSP parser refuses flags used as path values and unknown short options", () => {
  for (const args of [
    ["--aosp-root", "-j", "2"],
    ["--source-vendor", "-h"],
    ["-x"],
    ["--aosp-root", "/build", "-x"],
  ]) {
    assert.throws(
      () => parseSubArgs(args),
      /requires a value|Unknown argument/,
    );
  }
  assert.equal(parseSubArgs(["/build", "-j", "2"]).jobs, 2);
});

test("Cuttlefish lunch target remains one literal shell argument", (t) => {
  const { directory } = fixture(t);
  mkdirSync(join(directory, "build"));
  const output = join(directory, "lunch.txt");
  const sentinel = join(directory, "must-not-exist");
  const target = `product' $(touch ${sentinel}); variant`;
  writeFileSync(
    join(directory, "build/envsetup.sh"),
    'lunch() { printf "%s\\n" "$#" "$1" > "$LUNCH_OUTPUT"; }\ncvd() { return 0; }\n',
  );
  const command = cuttlefishLaunchCommand(
    { ...original, lunchTarget: target },
    {},
  );
  const result = spawnSync("bash", ["-c", command], {
    cwd: directory,
    env: { ...process.env, LUNCH_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), `1\n${target}\n`);
  assert.equal(existsSync(sentinel), false);
});
