import pc from "picocolors";
import { readPackageJson } from "../package-info.js";

export function version(): void {
  const packageJson = readPackageJson();
  console.log();
  console.log(pc.bold(pc.cyan("elizaOS CLI")));
  console.log();
  console.log(`  ${pc.dim("Version:")}  ${pc.green(packageJson.version)}`);
  console.log(`  ${pc.dim("Package:")}  ${packageJson.name}`);
  console.log();
  console.log(pc.dim("  Create and upgrade elizaOS projects and plugins."));
  console.log();
}
