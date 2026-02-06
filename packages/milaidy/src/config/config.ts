import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { resolveConfigPath } from "./paths.js";
import { resolveConfigIncludes } from "./includes.js";
import { collectConfigEnvVars } from "./env-vars.js";
import type { MilaidyConfig } from "./types.js";

export * from "./types.js";

export function loadMilaidyConfig(): MilaidyConfig {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return {} as MilaidyConfig;
  }

  const parsed = JSON5.parse(raw) as Record<string, unknown>;
  const resolved = resolveConfigIncludes(parsed, configPath) as MilaidyConfig;

  const envVars = collectConfigEnvVars(resolved);
  for (const [key, value] of Object.entries(envVars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return resolved;
}

export function saveMilaidyConfig(config: MilaidyConfig): void {
  const configPath = resolveConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function configFileExists(): boolean {
  return fs.existsSync(resolveConfigPath());
}
