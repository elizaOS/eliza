import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Build the trust module with host-selected identity and reviewed linker policy.
 * Callers serialize builds to an output path and provide a pinned Go module.
 * A failed tool invocation leaves the previous AAR intact.
 */
export function buildAndroidTrust({
  source,
  output,
  toolchain,
  ldflags,
  env = process.env,
}) {
  const {
    go,
    ndk,
    target,
    androidApi,
    javaPackage,
    ndkRevision = ndk,
  } = toolchain;
  if (
    !/^\d+\.\d+\.\d+$/.test(go) ||
    !/^\d+\.\d+\.\d+$/.test(ndk) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+)?$/.test(ndkRevision) ||
    !/^android\/(arm|arm64|386|amd64)(,android\/(arm|arm64|386|amd64))*$/.test(
      target,
    ) ||
    !Number.isInteger(androidApi) ||
    androidApi < 21 ||
    !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(javaPackage) ||
    typeof ldflags !== "string" ||
    !ldflags.trim()
  )
    throw new Error("Invalid Android trust build policy");
  if (!env.ANDROID_HOME || !env.JAVA_HOME)
    throw new Error("Android SDK and JDK paths are required");
  source = path.resolve(source);
  output = path.resolve(output);
  const ndkHome = path.join(env.ANDROID_HOME, "ndk", ndk);
  const properties = fs.readFileSync(
    path.join(ndkHome, "source.properties"),
    "utf8",
  );
  if (
    !properties
      .split(/\r?\n/)
      .some((line) => line.trim() === `Pkg.Revision = ${ndkRevision}`)
  )
    throw new Error(`Android trust build requires NDK ${ndkRevision}`);
  const buildEnv = { ...env, ANDROID_NDK_HOME: ndkHome, GOTOOLCHAIN: "local" };
  const version = execFileSync("go", ["env", "GOVERSION"], {
    cwd: source,
    env: buildEnv,
    encoding: "utf8",
  }).trim();
  if (version !== `go${go}`)
    throw new Error(`Android trust build requires Go ${go}; got ${version}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(output), ".android-trust-"),
  );
  try {
    buildEnv.PATH = [
      temporary,
      path.join(env.JAVA_HOME, "bin"),
      env.PATH || "",
    ].join(path.delimiter);
    const run = (args) =>
      execFileSync("go", args, {
        cwd: source,
        env: buildEnv,
        stdio: "inherit",
      });
    run([
      "build",
      "-trimpath",
      "-o",
      path.join(temporary, "gobind"),
      "golang.org/x/mobile/cmd/gobind",
    ]);
    const staged = path.join(temporary, "otatrust.aar");
    run([
      "tool",
      "gomobile",
      "bind",
      `-target=${target}`,
      `-androidapi=${androidApi}`,
      `-javapkg=${javaPackage}`,
      "-trimpath",
      `-ldflags=${ldflags}`,
      "-o",
      staged,
      ".",
    ]);
    if (!fs.statSync(staged).isFile() || fs.statSync(staged).size === 0)
      throw new Error("Android trust build produced no AAR");
    fs.renameSync(staged, output);
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
