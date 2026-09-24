import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Android setup discovers OS-owned releases without invented fallbacks", async () => {
  const adbBackend = await source(
    "setup/src/backend/adb-backend.ts",
  );
  assert.match(adbBackend, /repos\/elizaOS\/os\/releases/);
  assert.doesNotMatch(adbBackend, /MOCK_BUILDS/);
  assert.doesNotMatch(adbBackend, /downloads\.elizaos\.ai\/android\/beta/);
  assert.match(adbBackend, /No published elizaOS Android release manifests/);
});

test("USB installer has no fabricated production image inventory", async () => {
  const dryRunBackend = await source(
    "usb-installer/src/backend/dry-run-backend.ts",
  );
  assert.match(
    dryRunBackend,
    /export const DEFAULT_ELIZAOS_IMAGES: ElizaOsImage\[\] = \[\];/,
  );
  assert.doesNotMatch(dryRunBackend, /download\.elizaos\.ai/);
  assert.doesNotMatch(dryRunBackend, /linux-live-nightly-2026/);

  for (const platform of ["linux", "macos", "windows"]) {
    const backend = await source(
      `usb-installer/src/backend/${platform}-backend.ts`,
    );
    assert.match(backend, /fetch(?:PublishedIsoImages|ReleaseImages)/);
  }

  const discovery = await source(
    "usb-installer/src/backend/release-discovery.ts",
  );
  assert.match(discovery, /repos\/elizaOS\/os\/releases/);
  assert.match(discovery, /`\$\{iso\.name\}\.sha256`/);
  assert.match(discovery, /hasTrustedChecksum\(checksum\)/);
  assert.doesNotMatch(discovery, /repos\/elizaos\/eliza\/releases/i);
});
