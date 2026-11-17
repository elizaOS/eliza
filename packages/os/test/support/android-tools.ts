// spec/os/image/apk.md, "Story: Put only a reviewed release APK into an image"; spec/os/image/staging.md, "Story: Stage my launcher into an image exactly once"; spec/os/build/runtimePayload.md, "Story: Ship the agent with a pinned Node runtime"
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BUILD_TOOLS = "36.0.0";
export const PLATFORM = "android-36";

export type NativeAbi = "arm64-v8a" | "x86_64";

export type AndroidTools =
  | { readonly kind: "present"; readonly sdk: string; readonly aapt: string; readonly aapt2: string; readonly apksigner: string; readonly zipalign: string; readonly androidJar: string; readonly keytool: string }
  | { readonly kind: "missing"; readonly reason: string };

export interface TestSigner {
  readonly keystore: string;
  readonly password: string;
  readonly alias: string;
  readonly certificateSha256: string;
}

export interface FixtureApk {
  readonly directory: string;
  readonly manifest: string;
  readonly signer: TestSigner;
  readonly name: string;
  readonly natives?: Readonly<Partial<Record<NativeAbi, Readonly<Record<string, Uint8Array>>>>>;
  readonly assets?: Readonly<Record<string, string | Uint8Array>>;
}

export interface BuiltApk {
  readonly apk: string;
  readonly sha256: string;
}

const ELF_MACHINE: Readonly<Record<NativeAbi, number>> = { "arm64-v8a": 183, x86_64: 62 };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function androidTools(environment: NodeJS.ProcessEnv = process.env): AndroidTools {
  const sdk = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT, path.join(homedir(), "Library", "Android", "sdk"), path.join(homedir(), "Android", "Sdk")]
    .find((candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate));
  if (sdk === undefined) return { kind: "missing", reason: "no Android SDK in ANDROID_HOME, ANDROID_SDK_ROOT or the default locations" };
  const buildTools = path.join(sdk, "build-tools", BUILD_TOOLS);
  const androidJar = path.join(sdk, "platforms", PLATFORM, "android.jar");
  const java = environment.JAVA_HOME ? path.join(environment.JAVA_HOME, "bin") : undefined;
  const keytool = java && existsSync(path.join(java, "keytool")) ? path.join(java, "keytool") : "keytool";
  const tools = { aapt: path.join(buildTools, "aapt"), aapt2: path.join(buildTools, "aapt2"), apksigner: path.join(buildTools, "apksigner"), zipalign: path.join(buildTools, "zipalign") };
  const absent = [...Object.values(tools), androidJar].filter((file) => !existsSync(file));
  if (absent.length) return { kind: "missing", reason: `build-tools ${BUILD_TOOLS} and platform ${PLATFORM} are required; missing ${absent.join(", ")}` };
  return { kind: "present", sdk, androidJar, keytool, ...tools };
}

export function testSigner(tools: Extract<AndroidTools, { kind: "present" }>, directory: string, name = "fixture"): TestSigner {
  const keystore = path.join(directory, `${name}.p12`);
  const password = "fixture-only";
  const alias = name;
  if (!existsSync(keystore))
    execFileSync(tools.keytool, ["-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-storepass", password, "-keypass", password, "-alias", alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", `CN=${name} fixture`], { stdio: "ignore" });
  const certificate = execFileSync(tools.keytool, ["-exportcert", "-keystore", keystore, "-storetype", "PKCS12", "-storepass", password, "-alias", alias]);
  return { keystore, password, alias, certificateSha256: sha256(certificate) };
}

export function buildApk(tools: Extract<AndroidTools, { kind: "present" }>, fixture: FixtureApk): BuiltApk {
  mkdirSync(fixture.directory, { recursive: true });
  const work = mkdtempSync(path.join(fixture.directory, `.${fixture.name}-`));
  try {
    const manifest = path.join(work, "AndroidManifest.xml");
    writeFileSync(manifest, fixture.manifest);
    const assets = path.join(work, "assets");
    mkdirSync(assets);
    for (const [file, content] of Object.entries(fixture.assets ?? {})) {
      mkdirSync(path.dirname(path.join(assets, file)), { recursive: true });
      writeFileSync(path.join(assets, file), content);
    }
    const linked = path.join(work, "linked.apk");
    execFileSync(tools.aapt2, ["link", "--manifest", manifest, "-I", tools.androidJar, "-A", assets, "--min-sdk-version", "31", "--target-sdk-version", "36", "-o", linked], { stdio: "pipe" });
    const natives = Object.entries(fixture.natives ?? {}).flatMap(([abi, files]) => Object.entries(files ?? {}).map(([file, bytes]) => {
      const entry = `lib/${abi}/${file}`;
      mkdirSync(path.dirname(path.join(work, entry)), { recursive: true });
      writeFileSync(path.join(work, entry), bytes);
      return entry;
    }));
    if (natives.length) execFileSync(tools.aapt, ["add", "-0", "", linked, ...natives], { cwd: work, stdio: "pipe" });
    const aligned = path.join(work, "aligned.apk");
    execFileSync(tools.zipalign, ["-f", "-P", "16", "4", linked, aligned], { stdio: "pipe" });
    const apk = path.join(fixture.directory, `${fixture.name}.apk`);
    execFileSync(tools.apksigner, ["sign", "--ks", fixture.signer.keystore, "--ks-type", "PKCS12", "--ks-pass", `pass:${fixture.signer.password}`, "--ks-key-alias", fixture.signer.alias, "--out", apk, aligned], { stdio: "pipe" });
    rmSync(`${apk}.idsig`, { force: true });
    return { apk, sha256: sha256(readFileSync(apk)) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function standInElf(abi: NativeAbi): Uint8Array {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(ELF_MACHINE[abi], 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return header;
}
