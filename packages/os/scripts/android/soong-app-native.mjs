import { createHash } from "node:crypto";
import fs from "node:fs";

/** Reviewed build/soong extension for installing admitted APK native payloads. */
export function soongAppNativePatch() {
  const directory = new URL(
    "../../android/patches/soong-app-native/",
    import.meta.url,
  );
  const bytes = fs.readFileSync(new URL("manifest.json", directory));
  const manifest = JSON.parse(bytes);
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  if (
    hash(fs.readFileSync(new URL(manifest.patch, directory))) !==
    manifest.patchSha256
  )
    throw new Error("Soong native installation patch hash mismatch");
  if (
    hash(
      fs.readFileSync(
        new URL(
          "../../android/sources/pixel10a-stallion.json",
          import.meta.url,
        ),
      ),
    ) !== manifest.baselineLockSha256
  )
    throw new Error("Soong native installation source lock changed");
  return { name: "soong-app-native", manifest, manifestSha256: hash(bytes) };
}
