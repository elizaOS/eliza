import type { ElizaConfig } from "@elizaos/agent";
import type { Command } from "commander";
import { theme } from "@elizaos/shared";
import { getLogPrefix } from "@elizaos/shared";

export function registerConfigCli(program: Command) {
  const config = program
    .command("config")
    .description("Config helpers (get/path)");

  config
    .command("get <key>")
    .description("Get a config value")
    .action(async (key: string) => {
      const { loadElizaConfig } = await import("@elizaos/agent/config/config");
      let elizaConfig: ReturnType<typeof loadElizaConfig> | undefined;
      try {
        elizaConfig = loadElizaConfig();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`${getLogPrefix()} Could not load config: ${detail}`);
        process.exit(1);
      }
      const parts = key.split(".");
      let value: unknown = elizaConfig;
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }
      if (value === undefined) {
        console.log(`${theme.muted("(not set)")}`);
      } else {
        console.log(
          typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value),
        );
      }
    });

  config
    .command("path")
    .description("Print the resolved config file path")
    .action(async () => {
      const { resolveConfigPath } = await import("@elizaos/agent/config/paths");
      console.log(resolveConfigPath());
    });

  config
    .command("show")
    .description("Display all configuration values grouped by section")
    .option("-a, --all", "Include advanced/hidden fields")
    .option("--json", "Output as raw JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { loadElizaConfig } = await import("@elizaos/agent/config/config");
      const { buildConfigSchema } = await import(
        "@elizaos/agent/config/schema"
      );

      let config: ElizaConfig | undefined;
      try {
        config = loadElizaConfig();
      } catch (err) {
        console.error(
          theme.error(
            `Could not load config: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }

      const { uiHints } = buildConfigSchema();
      displayConfig(config ?? {}, uiHints, { showAdvanced: !!opts.all });
    });
}

/**
 * Flatten a nested object to dot-notation keys.
 */
function flattenConfig(obj: unknown, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (obj === null || typeof obj !== "object") {
    return { [prefix]: obj };
  }

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenConfig(value, path));
    } else {
      result[path] = value;
    }
  }

  return result;
}

/**
 * Infer a group name from a key path (e.g., "gateway.auth.token" → "Gateway").
 */
function inferGroup(key: string): string {
  const segments = key.split(".");
  if (segments.length === 0) return "General";
  const first = segments[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Display config values grouped by section.
 */
function displayConfig(
  config: Record<string, unknown>,
  uiHints: Record<
    string,
    {
      label?: string;
      help?: string;
      group?: string;
      sensitive?: boolean;
      advanced?: boolean;
      hidden?: boolean;
    }
  >,
  opts: { showAdvanced: boolean },
): void {
  const flat = flattenConfig(config);

  // Group fields by their group hint
  const groups = new Map<string, Array<[string, unknown]>>();

  for (const [key, value] of Object.entries(flat)) {
    const hint = uiHints[key];

    // Skip hidden fields
    if (hint?.hidden) continue;

    // Skip advanced fields unless requested
    if (!opts.showAdvanced && hint?.advanced) continue;

    const group = hint?.group ?? inferGroup(key);

    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)?.push([key, value]);
  }

  // Sort groups alphabetically
  const sortedGroups = Array.from(groups.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [groupName, fields] of sortedGroups) {
    console.log(`\n${theme.heading(groupName)}`);

    for (const [key, value] of fields) {
      const hint = uiHints[key];
      const label = hint?.label ?? key;
      const isSensitive = hint?.sensitive ?? false;
      const isSet = value !== undefined && value !== null && value !== "";

      let displayValue: string;
      if (!isSet) {
        displayValue = theme.muted("(not set)");
      } else if (isSensitive) {
        displayValue = theme.muted("●●●●●●●●");
      } else if (typeof value === "object") {
        displayValue = JSON.stringify(value);
      } else {
        displayValue = String(value);
      }

      const help = hint?.help ? `  ${theme.muted(`(${hint.help})`)}` : "";

      // Format: label (padded), value, help
      const paddedLabel = label.padEnd(24);
      console.log(`  ${theme.accent(paddedLabel)} ${displayValue}${help}`);
    }
  }

  console.log(); // Trailing newline
}
