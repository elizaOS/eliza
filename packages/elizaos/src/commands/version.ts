/**
 * Version command
 */

import pc from "picocolors";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  version: string;
  name: string;
  description: string;
}

export function version(): void {
  // Load package.json
  let packageJson: PackageJson;
  try {
    const packagePath = path.join(__dirname, "..", "..", "package.json");
    const content = fs.readFileSync(packagePath, "utf-8");
    packageJson = JSON.parse(content) as PackageJson;
  } catch {
    // Fallback for when running from dist
    const distPackagePath = path.join(__dirname, "..", "..", "..", "package.json");
    const content = fs.readFileSync(distPackagePath, "utf-8");
    packageJson = JSON.parse(content) as PackageJson;
  }

  console.log();
  console.log(pc.bold(pc.cyan("elizaOS CLI")));
  console.log();
  console.log(`  ${pc.dim("Version:")}  ${pc.green(packageJson.version)}`);
  console.log(`  ${pc.dim("Package:")}  ${packageJson.name}`);
  console.log();
  console.log(pc.dim("  Create elizaOS example projects with ease."));
  console.log();
  console.log(pc.dim("  Run 'elizaos --help' for available commands."));
  console.log();
}

