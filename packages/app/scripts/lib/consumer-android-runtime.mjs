import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConsumerSourceError,
  inspectDevelopmentRuntime,
} from "./committed-source.mjs";

/** Build a pinned mobile payload; the consumer supplies skills and gateway composition. */
export function buildConsumerAndroidRuntime({
  source,
  expectedCommit,
  output,
  skillsDirectory,
  bunArchiveFile,
  stageGateway,
}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || ""))
    throw new ConsumerSourceError("A full reviewed source commit is required");
  inspectDevelopmentRuntime({ source, expectedCommit });
  source = fs.realpathSync(source);
  output = path.resolve(output);
  if (typeof stageGateway !== "function")
    throw new ConsumerSourceError(
      "A host gateway staging callback is required",
    );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const git = (...args) => execFileSync("git", ["-C", source, ...args]);
  const env = Object.fromEntries(
    [
      "HOME",
      "PATH",
      "TMPDIR",
      "TEMP",
      "SYSTEMROOT",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  // A slow network can exceed the upstream downloader's 60-second deadline.
  // Its existing local-archive path verifies both archive and extracted binary
  // against the same reviewed hashes; it never bypasses the version pin.
  if (bunArchiveFile)
    env.ELIZA_BUN_AARCH64_FILE = fs.realpathSync(bunArchiveFile);
  const before = {
    commit: git("rev-parse", "HEAD").toString().trim(),
    trackedDiffSha256: hash(git("diff", "HEAD", "--binary")),
    lockSha256: hash(fs.readFileSync(path.join(source, "bun.lock"))),
  };
  // Exclusive destination prevents a failed rebuild from leaving a mixed payload.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  output = fs.realpathSync(output);

  function execute(args, extraEnv = {}) {
    execFileSync("bun", ["--no-env-file", "--no-install", ...args], {
      cwd: source,
      env: { ...env, ...extraEnv },
      stdio: "inherit",
    });
  }

  // Upstream's own Android builders, unmodified: the mobile bundle writes to the
  // source checkout's ignored packages/agent/dist-mobile, then the stager copies
  // it and the pinned ARM64 Bun runtime into this output's Android tree.
  const buildRelative = "packages/agent/scripts/build-mobile-bundle.ts";
  const stageRelative = "packages/app/scripts/lib/stage-android-agent.ts";
  const buildSourceHash = hash(
    fs.readFileSync(path.join(source, buildRelative)),
  );
  const stageSourceHash = hash(
    fs.readFileSync(path.join(source, stageRelative)),
  );
  execute([buildRelative, "--target=android"]);
  const distMobile = path.join(source, "packages/agent/dist-mobile");
  // The staging contract requires skills; supply this product's assistance
  // policy only when the upstream bundle emits none.
  if (!fs.existsSync(path.join(distMobile, "skills")))
    fs.cpSync(skillsDirectory, path.join(distMobile, "skills"), {
      recursive: true,
    });
  const stageRunner = path.join(output, "stage-runtime.mjs");
  fs.writeFileSync(
    stageRunner,
    `import {stageAndroidAgentRuntime} from ${JSON.stringify(pathToFileURL(path.join(source, stageRelative)).href)};\nawait stageAndroidAgentRuntime({androidDir:${JSON.stringify(path.join(output, "android"))},spikeDir:${JSON.stringify(path.join(source, "packages/app/scripts/aosp"))},objective:false});\n`,
    { flag: "wx" },
  );
  execute([stageRunner], { ELIZA_ANDROID_TARGET_ABIS: "arm64-v8a" });
  const gatewayHashes = stageGateway(output, source);

  if (
    before.commit !== git("rev-parse", "HEAD").toString().trim() ||
    before.trackedDiffSha256 !== hash(git("diff", "HEAD", "--binary")) ||
    before.lockSha256 !==
      hash(fs.readFileSync(path.join(source, "bun.lock"))) ||
    git("status", "--porcelain", "--untracked-files=normal").toString().trim()
  )
    throw new ConsumerSourceError(
      "Source changed during runtime build; output is not coherent",
    );
  const main = path.join(output, "android/app/src/main");
  const manifestPath = path.join(
    main,
    "assets/agent/android-agent-runtime-provenance.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (manifest.schema !== "eliza.android_agent_runtime_provenance.v1")
    throw new ConsumerSourceError("Unknown upstream runtime provenance schema");
  const entries = new Set();
  if (!Array.isArray(manifest.files))
    throw new ConsumerSourceError("Missing runtime provenance files");
  for (const file of manifest.files) {
    if (
      !/^(assets\/agent\/|lib\/)/.test(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => ["..", ".", ""].includes(part)) ||
      entries.has(file.path)
    )
      throw new ConsumerSourceError("Invalid upstream runtime provenance path");
    entries.add(file.path);
    const local = path.join(main, file.path.replace(/^lib\//, "jniLibs/"));
    if (
      !fs.realpathSync(local).startsWith(`${main}${path.sep}`) ||
      fs.lstatSync(local).isSymbolicLink() ||
      fs.statSync(local).size !== file.size_bytes ||
      hash(fs.readFileSync(local)) !== file.sha256
    )
      throw new ConsumerSourceError(
        `Staged runtime integrity failed: ${file.path}`,
      );
  }
  for (const name of [
    "libeliza_bun.so",
    "libeliza_ld_musl_aarch64.so",
    "libeliza_ld_musl_aarch64_real.so",
    "libeliza_stdcpp.so",
    "libeliza_gcc_s.so",
    "libsigsys-handler.so",
  ]) {
    const local = path.join(main, "jniLibs/arm64-v8a", name);
    const bytes = fs.readFileSync(local);
    if (
      !entries.has(`lib/arm64-v8a/${name}`) ||
      bytes.length < 64 ||
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 183
    )
      throw new ConsumerSourceError(
        `Invalid ARM64 runtime executable: ${name}`,
      );
  }
  const provenance = {
    schema: "eliza.consumer.android_runtime.v1",
    ...before,
    source,
    buildSourceHash,
    stageSourceHash,
    stageRunnerHash: hash(fs.readFileSync(stageRunner)),
    gatewayHashes,
    bundleSha256: hash(
      fs.readFileSync(path.join(distMobile, "agent-bundle.js")),
    ),
    stagedProvenanceSha256: hash(fs.readFileSync(manifestPath)),
    target: "arm64-v8a",
    completedAt: new Date().toISOString(),
    claim:
      "Fresh bundle module-load smoke and staged byte integrity only. Unreviewed development source; not a production APK or on-device execution.",
  };
  fs.writeFileSync(
    path.join(output, "development-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: "wx" },
  );
  return { output, provenance };
}
