#!/usr/bin/env node
/**
 * Applies packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch inside each
 * installed llama-cpp-capacitor copy.
 *
 * Bun's patchedDependencies applies patches with the repository root as cwd,
 * so paths like ios/Frameworks-xcframework/... get mkdir'd at the repo root
 * (and with mode 0644 those dirs are not traversable). Running patch(1) from
 * the package directory avoids that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const patchFile = join(
  repoRoot,
  "packages",
  "app-core",
  "patches",
  "llama-cpp-capacitor@0.1.5.patch",
);

/** @returns {Generator<string>} */
function* llamaCppPackageRoots() {
  const bunDir = join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("llama-cpp-capacitor@")) continue;
      const pkg = join(bunDir, entry, "node_modules", "llama-cpp-capacitor");
      if (existsSync(join(pkg, "package.json"))) yield pkg;
    }
  }
  const hoisted = join(repoRoot, "node_modules", "llama-cpp-capacitor");
  if (existsSync(join(hoisted, "package.json"))) yield hoisted;
}

function patchStatus(pkgRoot) {
  const jni = join(pkgRoot, "android", "src", "main", "jni.cpp");
  const swift = join(
    pkgRoot,
    "ios",
    "Sources",
    "LlamaCppPlugin",
    "LlamaCpp.swift",
  );
  if (!existsSync(jni)) return "missing";
  if (!existsSync(swift)) return "missing";
  const jniText = readFileSync(jni, "utf8");
  const swiftText = readFileSync(swift, "utf8");
  const hasBasePatch = jniText.includes("optDoubleMethod");
  const hasHashBridge = swiftText.includes("func hashFile");
  if (hasBasePatch && hasHashBridge) return "complete";
  if (hasBasePatch) return "legacy-without-hash";
  return "missing";
}

function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) {
    throw new Error(`[patch-llama-cpp-capacitor] ${label} anchor missing`);
  }
  return text.replace(search, replacement);
}

function applyHashBridge(pkgRoot) {
  const patchFile = (file, patcher) => {
    const before = readFileSync(file, "utf8");
    const after = patcher(before);
    if (after !== before) writeFileSync(file, after, "utf8");
  };

  const swiftPath = join(pkgRoot, "ios", "Sources", "LlamaCppPlugin", "LlamaCpp.swift");
  patchFile(swiftPath, (text) => {
    let patched = text.includes("import CryptoKit")
      ? text
      : replaceOnce(
          text,
          "import Foundation\nimport Capacitor\nimport Darwin",
          "import Foundation\nimport Capacitor\nimport CryptoKit\nimport Darwin",
          "LlamaCpp.swift imports",
        );
    if (patched.includes("func hashFile")) return patched;
    const method = `    func hashFile(path: String, completion: @escaping (LlamaResult<[String: Any]>) -> Void) {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: path) else {
            completion(.failure(.operationFailed("File does not exist: \\(path)")))
            return
        }
        guard let handle = FileHandle(forReadingAtPath: path) else {
            completion(.failure(.operationFailed("Could not open file for hashing: \\(path)")))
            return
        }

        DispatchQueue.global(qos: .utility).async {
            var hasher = SHA256()
            var size: UInt64 = 0
            do {
                while true {
                    let data = try handle.read(upToCount: 1_048_576) ?? Data()
                    if data.isEmpty {
                        break
                    }
                    size += UInt64(data.count)
                    hasher.update(data: data)
                }
                try handle.close()
                let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
                DispatchQueue.main.async {
                    completion(.success([
                        "sha256": digest,
                        "sizeBytes": NSNumber(value: size)
                    ]))
                }
            } catch {
                try? handle.close()
                DispatchQueue.main.async {
                    completion(.failure(.operationFailed("Hash failed: \\(error.localizedDescription)")))
                }
            }
        }
    }

`;
    return replaceOnce(
      patched,
      "    public func urlSession(\n",
      `${method}    public func urlSession(\n`,
      "LlamaCpp.swift urlSession",
    );
  });

  const pluginSwiftPath = join(pkgRoot, "ios", "Sources", "LlamaCppPlugin", "LlamaCppPlugin.swift");
  patchFile(pluginSwiftPath, (text) => {
    let patched = text.includes('CAPPluginMethod(name: "hashFile"')
      ? text
      : replaceOnce(
          text,
          '        CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),\n        CAPPluginMethod(name: "getDownloadProgress", returnType: CAPPluginReturnPromise),',
          '        CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),\n        CAPPluginMethod(name: "hashFile", returnType: CAPPluginReturnPromise),\n        CAPPluginMethod(name: "getDownloadProgress", returnType: CAPPluginReturnPromise),',
          "LlamaCppPlugin.swift method list",
        );
    if (patched.includes("@objc func hashFile")) return patched;
    const bridge = `    @objc func hashFile(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""

        implementation.hashFile(path: path) { result in
            switch result {
            case .success(let fileHash):
                call.resolve(fileHash)
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }
    }
    
`;
    return replaceOnce(
      patched,
      "    @objc func cancelDownload(_ call: CAPPluginCall) {\n",
      `${bridge}    @objc func cancelDownload(_ call: CAPPluginCall) {\n`,
      "LlamaCppPlugin.swift cancelDownload",
    );
  });

  patchFile(join(pkgRoot, "dist", "esm", "index.js"), (text) =>
    text.includes("export async function hashFile")
      ? text
      : replaceOnce(
          text,
          "export async function downloadModel(url, filename) {\n    return LlamaCpp.downloadModel({ url, filename });\n}\n",
          "export async function downloadModel(url, filename) {\n    return LlamaCpp.downloadModel({ url, filename });\n}\nexport async function hashFile(path) {\n    return LlamaCpp.hashFile({ path });\n}\n",
          "dist/esm/index.js downloadModel",
        ),
  );

  patchFile(join(pkgRoot, "dist", "plugin.cjs.js"), (text) => {
    let patched = text.includes("async function hashFile")
      ? text
      : replaceOnce(
          text,
          "async function downloadModel(url, filename) {\n    return LlamaCpp.downloadModel({ url, filename });\n}\n",
          "async function downloadModel(url, filename) {\n    return LlamaCpp.downloadModel({ url, filename });\n}\nasync function hashFile(path) {\n    return LlamaCpp.hashFile({ path });\n}\n",
          "dist/plugin.cjs.js downloadModel",
        );
    return patched.includes("exports.hashFile = hashFile;")
      ? patched
      : replaceOnce(
          patched,
          "exports.getDownloadProgress = getDownloadProgress;\n",
          "exports.getDownloadProgress = getDownloadProgress;\nexports.hashFile = hashFile;\n",
          "dist/plugin.cjs.js exports",
        );
  });

  patchFile(join(pkgRoot, "dist", "plugin.js"), (text) => {
    let patched = text.includes("async function hashFile")
      ? text
      : replaceOnce(
          text,
          "    async function downloadModel(url, filename) {\n        return LlamaCpp.downloadModel({ url, filename });\n    }\n",
          "    async function downloadModel(url, filename) {\n        return LlamaCpp.downloadModel({ url, filename });\n    }\n    async function hashFile(path) {\n        return LlamaCpp.hashFile({ path });\n    }\n",
          "dist/plugin.js downloadModel",
        );
    return patched.includes("exports.hashFile = hashFile;")
      ? patched
      : replaceOnce(
          patched,
          "    exports.getDownloadProgress = getDownloadProgress;\n",
          "    exports.getDownloadProgress = getDownloadProgress;\n    exports.hashFile = hashFile;\n",
          "dist/plugin.js exports",
        );
  });

  patchFile(join(pkgRoot, "dist", "esm", "index.d.ts"), (text) =>
    text.includes("hashFile(path")
      ? text
      : replaceOnce(
          text,
          "export declare function downloadModel(url: string, filename: string): Promise<string>;\n",
          "export declare function downloadModel(url: string, filename: string): Promise<string>;\nexport declare function hashFile(path: string): Promise<{\n    sha256: string;\n    sizeBytes: number;\n}>;\n",
          "dist/esm/index.d.ts downloadModel",
        ),
  );

  patchFile(join(pkgRoot, "types", "llama-cpp-capacitor.d.ts"), (text) =>
    text.includes("hashFile(path")
      ? text
      : replaceOnce(
          text,
          "  export function releaseAllLlama(): Promise<void>;\n\n  // Constants\n",
          "  export function releaseAllLlama(): Promise<void>;\n  export function downloadModel(url: string, filename: string): Promise<string | { path?: string }>;\n  export function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }>;\n  export function getDownloadProgress(url: string): Promise<Record<string, unknown>>;\n  export function cancelDownload(url: string): Promise<boolean | { cancelled: boolean }>;\n  export function getAvailableModels(): Promise<Array<{ name?: string; path?: string; size?: number }> | { models?: Array<{ name?: string; path?: string; size?: number }> }>;\n\n  // Constants\n",
          "types/llama-cpp-capacitor.d.ts releaseAllLlama",
        ),
  );
}

function main() {
  if (!existsSync(patchFile)) {
    console.warn(
      "[patch-llama-cpp-capacitor] Patch file missing — skipping:",
      patchFile,
    );
    process.exit(0);
  }

  let applied = 0;
  for (const pkgRoot of llamaCppPackageRoots()) {
    const status = patchStatus(pkgRoot);
    if (status === "complete") continue;
    if (status === "legacy-without-hash") {
      applyHashBridge(pkgRoot);
      applied++;
      console.log(`[patch-llama-cpp-capacitor] Added hash bridge to ${pkgRoot}`);
      continue;
    }

    const r = spawnSync(
      "patch",
      ["--batch", "-p1"],
      { cwd: pkgRoot, encoding: "utf8", input: readFileSync(patchFile) },
    );
    if (r.status !== 0) {
      console.error(r.stdout ?? "");
      console.error(r.stderr ?? "");
      process.exit(r.status ?? 1);
    }
    applied++;
    console.log(`[patch-llama-cpp-capacitor] Patched ${pkgRoot}`);
  }

  if (applied === 0) {
    console.log(
      "[patch-llama-cpp-capacitor] No installs to patch (or already patched).",
    );
  }
}

main();
