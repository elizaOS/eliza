import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Gradle strips native libraries and may transform compressed assets. Hash
// the final APK entries, independently of the pre-Gradle staging manifest.
export function packagedRuntimeFiles(apkPath) {
  const names = execFileSync("unzip", ["-Z1", apkPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  const runtimeNames = names.filter(
    (name) =>
      !name.endsWith("/") &&
      (name.startsWith("assets/agent/") || name.startsWith("lib/")),
  );
  if (new Set(names).size !== names.length) {
    throw new Error(
      "APK contains duplicate entry names; provenance is ambiguous.",
    );
  }
  if (!runtimeNames.includes("assets/agent/agent-bundle.js")) {
    throw new Error("System APK is missing its packaged agent bundle.");
  }
  return runtimeNames.sort().map((entry) => {
    const bytes = execFileSync("unzip", ["-p", apkPath, entry], {
      maxBuffer: 512 * 1024 * 1024,
    });
    return {
      path: entry,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}
