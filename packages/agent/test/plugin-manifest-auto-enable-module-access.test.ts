/**
 * A manifest's declared `autoEnableModule` that is present but unreadable
 * (ELOOP from a broken symlink, EACCES from a wrong owner/mode, EIO from a
 * damaged mount) must be reported as an import failure. It must not be
 * silently downgraded to "the plugin has no check module" — that path is
 * cached for the rest of the process and is reported to users as
 * `did not export a shouldEnable function`, which points at the plugin author
 * instead of at the broken install.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  evaluatePluginManifest,
  type PluginManifestCandidate,
} from "../src/host-manifests/plugin-manifest.ts";

const CTX = { env: {}, config: {}, isNativePlatform: false };

function candidate(packageRoot: string): PluginManifestCandidate {
  return { packageName: "@elizaos/plugin-probe", packageRoot };
}

async function writeManifest(
  packageRoot: string,
  autoEnableModule: string,
): Promise<void> {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@elizaos/plugin-probe",
      version: "0.0.0",
      elizaos: { plugin: { autoEnableModule } },
    }),
  );
}

async function tempPluginRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eliza-plugin-manifest-"));
}

it("reports an unreadable autoEnableModule as an import failure", async () => {
  const packageRoot = await tempPluginRoot();
  try {
    await writeManifest(packageRoot, "./check.mjs");
    // Self-referential symlink: the path exists as a directory entry but
    // resolving it fails with ELOOP, exactly like an unreadable or damaged
    // install. (chmod-based EACCES is silently bypassed when tests run as root.)
    await fs.symlink("check.mjs", path.join(packageRoot, "check.mjs"));

    const verdict = await evaluatePluginManifest(candidate(packageRoot), CTX);

    expect(verdict).not.toBeNull();
    expect(verdict?.enabled).toBe(false);
    // The failure must name the real problem (the module could not be read).
    expect(verdict?.error).toMatch(/failed to import autoEnableModule/);
    expect(verdict?.error).toContain("ELOOP");
    // …and must not blame the absent `shouldEnable` export.
    expect(verdict?.error).not.toContain(
      "did not export a shouldEnable function",
    );
  } finally {
    await fs.rm(packageRoot, { recursive: true, force: true });
  }
});

it("still treats a declared-but-unshipped autoEnableModule as not enabled", async () => {
  const packageRoot = await tempPluginRoot();
  try {
    await writeManifest(packageRoot, "./never-built.mjs");

    const verdict = await evaluatePluginManifest(candidate(packageRoot), CTX);

    // Unchanged legacy path: ENOENT is a legitimate "this plugin ships no
    // check module", so the plugin is simply not auto-enabled.
    expect(verdict?.enabled).toBe(false);
    expect(verdict?.error).toContain("did not export a shouldEnable function");
  } finally {
    await fs.rm(packageRoot, { recursive: true, force: true });
  }
});

it("evaluates a readable autoEnableModule", async () => {
  const packageRoot = await tempPluginRoot();
  try {
    await writeManifest(packageRoot, "./check.mjs");
    await fs.writeFile(
      path.join(packageRoot, "check.mjs"),
      "export function shouldEnable() { return true; }\n",
    );

    const verdict = await evaluatePluginManifest(candidate(packageRoot), CTX);

    expect(verdict?.error).toBeNull();
    expect(verdict?.enabled).toBe(true);
  } finally {
    await fs.rm(packageRoot, { recursive: true, force: true });
  }
});
