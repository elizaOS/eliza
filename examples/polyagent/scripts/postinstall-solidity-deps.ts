#!/usr/bin/env bun
/**
 * Postinstall script for Solidity dependencies
 * Downloads and sets up Foundry/Soldeer dependencies automatically
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dir, "..");
const DEPS_DIR = join(ROOT_DIR, "packages", "contracts", "dependencies");

interface SoldeerPackage {
  name: string;
  version: string;
  folderName: string;
  url: string;
}

const PACKAGES: SoldeerPackage[] = [
  {
    name: "forge-std",
    version: "1.9.4",
    folderName: "forge-std-1.9.4",
    url: "https://soldeer-revisions.s3.amazonaws.com/forge-std/1_9_4_25-10-2024_14:36:59_forge-std-1.9.zip",
  },
  {
    name: "@openzeppelin-contracts",
    version: "5.2.0",
    folderName: "@openzeppelin-contracts-5.2.0",
    url: "https://soldeer-revisions.s3.amazonaws.com/@openzeppelin-contracts/5_2_0_11-01-2025_09:30:20_contracts.zip",
  },
];

async function downloadAndExtract(pkg: SoldeerPackage): Promise<boolean> {
  const targetDir = join(DEPS_DIR, pkg.folderName);

  // Check if already exists
  if (existsSync(targetDir)) {
    console.log(`   ✓ ${pkg.name}@${pkg.version} already installed`);
    return true;
  }

  console.log(`   ⬇ Downloading ${pkg.name}@${pkg.version}...`);

  try {
    const response = await fetch(pkg.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const zipBuffer = await response.arrayBuffer();
    const tempZip = join(DEPS_DIR, `${pkg.name.replace("/", "-")}.zip`);

    // Write zip file
    await Bun.write(tempZip, zipBuffer);

    // Extract using unzip command
    const proc = Bun.spawn(["unzip", "-o", "-q", tempZip, "-d", targetDir], {
      cwd: DEPS_DIR,
      stdout: "ignore",
      stderr: "pipe",
    });

    await proc.exited;

    // Clean up zip file
    rmSync(tempZip, { force: true });

    if (proc.exitCode === 0) {
      console.log(`   ✓ ${pkg.name}@${pkg.version} installed`);
      return true;
    }

    const stderr = await new Response(proc.stderr).text();
    console.error(`   ✗ Failed to extract ${pkg.name}: ${stderr}`);
    return false;
  } catch (error) {
    console.error(
      `   ✗ Failed to download ${pkg.name}: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}

async function checkForge(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["forge", "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\n🔧 Setting up Solidity dependencies...");

  // Check if Forge is installed
  const hasForge = await checkForge();
  if (!hasForge) {
    console.log(
      "   ⚠️  Foundry (forge) not installed. Skipping Solidity setup.",
    );
    console.log(
      "   💡 Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup",
    );
    return;
  }

  // Create dependencies directory
  if (!existsSync(DEPS_DIR)) {
    mkdirSync(DEPS_DIR, { recursive: true });
  }

  // Download packages
  let allSuccess = true;
  for (const pkg of PACKAGES) {
    const success = await downloadAndExtract(pkg);
    if (!success) allSuccess = false;
  }

  if (allSuccess) {
    console.log("   ✅ Solidity dependencies ready\n");
  } else {
    console.log("   ⚠️  Some dependencies failed to install\n");
    console.log("   💡 Try running: forge soldeer update\n");
  }
}

main().catch(console.error);
