import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { collectConfigEnvVars } from "./env-vars";
import { resolveConfigIncludes } from "./includes";
import { resolveConfigPath, resolveUserPath } from "./paths";
import type { ElizaConfig } from "./types";

export * from "./types";

export function loadElizaConfig(): ElizaConfig {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { logging: { level: "error" } } as ElizaConfig;
    }
    throw err;
  }

  const parsed = JSON5.parse(raw) as Record<string, unknown>;
  const resolved = resolveConfigIncludes(parsed, configPath) as ElizaConfig;

  const skillsJsonPath = resolveUserPath("~/.eliza/skills.json");

  if (!fs.existsSync(skillsJsonPath)) {
    try {
      const skillsDir = path.dirname(skillsJsonPath);
      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }
      fs.writeFileSync(
        skillsJsonPath,
        JSON.stringify({ extraDirs: [] }, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn(
        `[eliza] Failed to auto-create ~/.eliza/skills.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (fs.existsSync(skillsJsonPath)) {
    try {
      const skillsRaw = fs.readFileSync(skillsJsonPath, "utf-8");
      const skillsConfig = JSON5.parse(skillsRaw) as { extraDirs?: string[] };

      if (
        skillsConfig.extraDirs &&
        Array.isArray(skillsConfig.extraDirs) &&
        skillsConfig.extraDirs.length > 0
      ) {
        if (!resolved.skills) resolved.skills = {};
        if (!resolved.skills.load) resolved.skills.load = {};
        if (!resolved.skills.load.extraDirs) {
          resolved.skills.load.extraDirs = [];
        }

        const existing = new Set(resolved.skills.load.extraDirs);
        for (const dir of skillsConfig.extraDirs) {
          const loadedDir = resolveUserPath(dir);
          if (!existing.has(loadedDir)) {
            resolved.skills.load.extraDirs.push(loadedDir);
            existing.add(loadedDir);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[eliza] Failed to load ~/.eliza/skills.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!resolved.logging) {
    resolved.logging = { level: "error" };
  } else if (!resolved.logging.level) {
    resolved.logging.level = "error";
  }

  const envVars = collectConfigEnvVars(resolved);
  for (const [key, value] of Object.entries(envVars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return resolved;
}

function stripIncludeDirectives(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripIncludeDirectives);
  if (typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$include") continue;
    result[key] = stripIncludeDirectives(val);
  }
  return result;
}

export function saveElizaConfig(config: ElizaConfig): void {
  const configPath = resolveConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const sanitized = stripIncludeDirectives(config);
  if (!sanitized || typeof sanitized !== "object") {
    throw new Error(
      `[eliza-config] stripIncludeDirectives returned invalid result: ${typeof sanitized}`,
    );
  }

  const content = `${JSON.stringify(sanitized, null, 2)}\n`;

  fs.writeFileSync(configPath, content, {
    encoding: "utf-8",
    mode: 0o600,
  });

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `[eliza-config] Config file missing after write: ${configPath}`,
    );
  }
  const stat = fs.statSync(configPath);
  if (stat.size === 0) {
    throw new Error(
      `[eliza-config] Config file is empty after write: ${configPath}`,
    );
  }
}

export function configFileExists(): boolean {
  return fs.existsSync(resolveConfigPath());
}

// Backward-compat aliases for downstream forks using the old name
