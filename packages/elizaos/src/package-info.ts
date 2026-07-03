import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  description: string;
  name: string;
  version: string;
}

export function getPackageRoot(): string {
  return path.resolve(__dirname, "..");
}

export function readPackageJson(): PackageJson {
  const packagePath = path.join(getPackageRoot(), "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as PackageJson;
}

export function getCliVersion(): string {
  return readPackageJson().version;
}
