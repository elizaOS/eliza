import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Load .env.local then .env from the cloud package root, without overwriting
 * already-set process.env entries. `daemonUrl` should be `import.meta.url` of
 * the calling daemon at packages/scripts/daemons/<name>.ts.
 */
export function loadLocalEnv(daemonUrl: string): void {
  const scriptPath = fileURLToPath(daemonUrl);
  const projectRoot = path.resolve(path.dirname(scriptPath), "../../..");
  loadEnvFile(path.join(projectRoot, ".env.local"));
  loadEnvFile(path.join(projectRoot, ".env"));
}
