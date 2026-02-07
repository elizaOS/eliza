import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";

export function registerConfigCli(program: Command) {
  const config = program
    .command("config")
    .description("Config helpers (get/path)");

  config
    .command("get <key>")
    .description("Get a config value")
    .action(async (key: string) => {
      const { loadMilaidyConfig } = await import("../../config/config.js");
      let milaidyConfig;
      try {
        milaidyConfig = loadMilaidyConfig();
      } catch {
        console.error("[milaidy] Could not load config.");
        process.exit(1);
      }
      const parts = key.split(".");
      let value: unknown = milaidyConfig;
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
        console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
      }
    });

  config
    .command("path")
    .description("Print the resolved config file path")
    .action(async () => {
      const { resolveConfigPath } = await import("../../config/paths.js");
      console.log(resolveConfigPath());
    });
}
