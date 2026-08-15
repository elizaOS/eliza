/**
 * Post-build evidence gate for iOS cloud-only `.app` and `.ipa` artifacts.
 * It inspects the bytes Xcode produced, rejects embedded local-runtime products
 * and native link/symbol indicators, proves the packaged renderer matches the
 * fresh dist, verifies device signatures when required, and writes a bounded
 * attestation. This is artifact evidence only; it does not claim simulator,
 * physical-device, login, network, or runtime behavior.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";

import { assertStagedRendererMatchesBuild } from "./renderer-build-manifest.mjs";

export const IOS_CLOUD_ARTIFACT_ATTESTATION_SCHEMA =
  "elizaos.ios-cloud-artifact-attestation/v1";

const FORBIDDEN_PRODUCT_PATTERNS = Object.freeze([
  /(?:^|[/_.-])ElizaBunEngine(?:$|[/_.-])/i,
  /(?:^|[/_.-])ElizaosCapacitorBunRuntime(?:$|[/_.-])/i,
  /(?:^|[/_.-])ElizaosCapacitorMobileAgentBridge(?:$|[/_.-])/i,
  /(?:^|[/_.-])MobileAgentBridge(?:$|[/_.-])/i,
  /(?:^|[/_.-])LlamaCpp(?:Capacitor)?(?:$|[/_.-])/i,
  /(?:^|[/_.-])llama-cpp(?:$|[/_.-])/i,
  /(?:^|\/)agent-bundle\.js$/i,
  /\.(?:gguf|ggml)$/i,
]);

const FORBIDDEN_NATIVE_INDICATORS = Object.freeze([
  /ElizaBunEngine/i,
  /ElizaosCapacitorBunRuntime/i,
  /ElizaosCapacitorMobileAgentBridge/i,
  /MobileAgentBridgePlugin/i,
  /LlamaCppCapacitor/i,
  /(?:^|[^A-Za-z0-9])_?llama_(?:model|context|backend|load|decode|encode)/im,
  /(?:^|[^A-Za-z0-9])_?ggml_(?:backend|graph|tensor|alloc)/im,
  /agent-bundle\.js/i,
]);

const MACH_O_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function defaultCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function isMachO(filePath) {
  const handle = fs.openSync(filePath, "r");
  const magic = Buffer.alloc(4);
  try {
    if (fs.readSync(handle, magic, 0, magic.length, 0) !== magic.length) {
      return false;
    }
  } finally {
    fs.closeSync(handle);
  }
  return MACH_O_MAGICS.has(magic.toString("hex"));
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  if (files.length > 100_000) {
    throw new Error(`iOS app has ${files.length} files; audit limit is 100000`);
  }
  return files.sort();
}

function sha256AppTree(appPath, files) {
  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    const relativePath = path
      .relative(appPath, filePath)
      .split(path.sep)
      .join("/");
    hash.update(`${relativePath}\0${fs.statSync(filePath).size}\0`);
    hash.update(sha256File(filePath));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function extractIpa(ipaPath, tempRoot) {
  const zip = new AdmZip(ipaPath);
  const entries = zip.getEntries();
  if (entries.length > 100_000) {
    throw new Error(`IPA has ${entries.length} entries; audit limit is 100000`);
  }
  let expandedBytes = 0;
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.entryName);
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`IPA contains unsafe entry path: ${entry.entryName}`);
    }
    expandedBytes += entry.header.size;
    if (expandedBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error("IPA expanded size exceeds the 2 GiB audit limit");
    }
  }
  zip.extractAllTo(tempRoot, true, false);
  const payloadDir = path.join(tempRoot, "Payload");
  const apps = fs.existsSync(payloadDir)
    ? fs
        .readdirSync(payloadDir)
        .filter((name) => name.endsWith(".app"))
        .sort()
    : [];
  if (apps.length !== 1) {
    throw new Error(
      `IPA must contain exactly one Payload/*.app; found ${apps.length}`,
    );
  }
  return path.join(payloadDir, apps[0]);
}

function resolveAppArtifact(artifactPath) {
  const resolved = path.resolve(artifactPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`iOS artifact does not exist: ${resolved}`);
  }
  if (resolved.endsWith(".app") && fs.statSync(resolved).isDirectory()) {
    return { appPath: resolved, cleanup: () => {}, kind: "app" };
  }
  if (resolved.endsWith(".ipa") && fs.statSync(resolved).isFile()) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ios-cloud-audit-"));
    try {
      const appPath = extractIpa(resolved, tempRoot);
      return {
        appPath,
        cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
        kind: "ipa",
      };
    } catch (error) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`Expected an iOS .app directory or .ipa file: ${resolved}`);
}

function indicatorMatches(text) {
  return FORBIDDEN_NATIVE_INDICATORS.filter((pattern) =>
    pattern.test(text),
  ).map((pattern) => pattern.source);
}

/** Audits a final cloud-only iOS artifact and writes its machine-readable proof. */
export function auditIosCloudArtifact({
  artifactPath,
  freshDistDir,
  expectedRuntimeMode = null,
  requireCodesign = false,
  attestationPath = `${path.resolve(artifactPath)}.eliza-cloud-attestation.json`,
  command = defaultCommand,
  now = () => new Date().toISOString(),
}) {
  const findings = [];
  const binaries = [];
  let renderer = null;
  let signature = { status: "not-required", verified: false };
  let artifactSha256 = null;
  let resolved;
  try {
    resolved = resolveAppArtifact(artifactPath);
    const { appPath } = resolved;
    const files = walkFiles(appPath);
    artifactSha256 =
      resolved.kind === "ipa"
        ? sha256File(path.resolve(artifactPath))
        : sha256AppTree(appPath, files);
    for (const filePath of files) {
      const relativePath = path
        .relative(appPath, filePath)
        .split(path.sep)
        .join("/");
      if (
        FORBIDDEN_PRODUCT_PATTERNS.some((pattern) => pattern.test(relativePath))
      ) {
        findings.push(`forbidden local-runtime product: ${relativePath}`);
      }
      if (!isMachO(filePath)) continue;
      const sha256 = sha256File(filePath);
      const outputs = [];
      for (const [tool, args] of [
        ["xcrun", ["otool", "-L", filePath]],
        ["xcrun", ["nm", "-gjU", filePath]],
        ["xcrun", ["strings", "-a", filePath]],
      ]) {
        try {
          outputs.push(command(tool, args));
        } catch (error) {
          throw new Error(
            `Cannot inspect Mach-O ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const indicators = indicatorMatches(outputs.join("\n"));
      if (indicators.length > 0) {
        findings.push(
          `forbidden local-runtime native indicator in ${relativePath}: ${indicators.join(", ")}`,
        );
      }
      binaries.push({ path: relativePath, sha256, indicators });
    }
    if (binaries.length === 0) {
      findings.push("artifact contains no inspectable Mach-O binaries");
    }

    const publicDir = path.join(appPath, "public");
    const manifest = assertStagedRendererMatchesBuild(
      path.resolve(freshDistDir),
      publicDir,
      { label: "iOS cloud artifact" },
    );
    renderer = {
      buildId: manifest.buildId,
      commit: manifest.commit ?? null,
      runtimeMode: manifest.runtimeMode ?? null,
      variant: manifest.variant ?? null,
    };
    if (expectedRuntimeMode && renderer.runtimeMode !== expectedRuntimeMode) {
      findings.push(
        `renderer runtimeMode is ${JSON.stringify(renderer.runtimeMode)}; expected ${JSON.stringify(expectedRuntimeMode)}`,
      );
    }
    if (renderer.runtimeMode === "local") {
      findings.push(
        "renderer runtimeMode local contradicts a cloud-only artifact",
      );
    }

    const signaturePresent = fs.existsSync(
      path.join(appPath, "_CodeSignature"),
    );
    if (requireCodesign || signaturePresent) {
      try {
        command("codesign", [
          "--verify",
          "--deep",
          "--strict",
          "--verbose=2",
          appPath,
        ]);
        signature = { status: "verified", verified: true };
      } catch (error) {
        signature = {
          status: "failed",
          verified: false,
          error: error instanceof Error ? error.message : String(error),
        };
        throw new Error(
          `iOS artifact codesign verification failed: ${signature.error}`,
        );
      }
    } else {
      signature = {
        status: "not-applicable-unsigned-simulator-or-development-build",
        verified: false,
      };
    }
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
  } finally {
    resolved?.cleanup();
  }

  const attestation = {
    schema: IOS_CLOUD_ARTIFACT_ATTESTATION_SCHEMA,
    generatedAt: now(),
    artifact: path.basename(path.resolve(artifactPath)),
    artifactKind: resolved?.kind ?? null,
    artifactSha256,
    attestationFile: path.resolve(attestationPath),
    verdict: findings.length === 0 ? "pass" : "fail",
    policy: "ios-cloud-no-local-execution-products",
    renderer,
    signature,
    machOBinaries: binaries,
    findings,
    claimBoundary:
      "final-artifact-contents-and-signature-only_not_simulator_device_login_network_or_runtime-evidence",
  };
  fs.mkdirSync(path.dirname(path.resolve(attestationPath)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.resolve(attestationPath),
    `${JSON.stringify(attestation, null, 2)}\n`,
  );
  if (findings.length > 0) {
    throw new Error(
      `[mobile-build] iOS cloud artifact audit failed; attestation: ${path.resolve(attestationPath)}\n${findings
        .map((finding) => `  - ${finding}`)
        .join("\n")}`,
    );
  }
  return attestation;
}

/** Resolves the main `.app` from `xcodebuild -showBuildSettings -json`. */
export function resolveIosAppFromBuildSettingsJson(jsonText) {
  let entries;
  try {
    entries = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Could not parse xcodebuild settings JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const candidates = Array.isArray(entries)
    ? entries.filter((entry) => {
        const settings = entry?.buildSettings;
        return (
          settings?.WRAPPER_EXTENSION === "app" &&
          typeof settings.TARGET_BUILD_DIR === "string" &&
          typeof settings.WRAPPER_NAME === "string"
        );
      })
    : [];
  const main =
    candidates.find((entry) => entry.target === "App") ?? candidates[0];
  if (!main || candidates.length === 0) {
    throw new Error(
      "xcodebuild settings did not identify an application product",
    );
  }
  return path.join(
    main.buildSettings.TARGET_BUILD_DIR,
    main.buildSettings.WRAPPER_NAME,
  );
}
