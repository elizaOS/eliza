#!/usr/bin/env node
/**
 * Writes the legacy plugin-index manifest from the shipped first-party catalog.
 * Generation is offline and validates every entry before replacing the output;
 * a missing catalog or unwritable destination fails the command.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ElizaError, registryEntrySchema } from "@elizaos/core";

import catalog from "@elizaos/core/catalog/generated.json" with {
  type: "json",
};

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function generatePluginIndex(
  outputPath = path.join(packageRoot, "plugins.json"),
) {
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new ElizaError(
      "The shipped first-party catalog contains no entries",
      {
        code: "PLUGIN_INDEX_CATALOG_UNAVAILABLE",
        context: { outputPath },
      },
    );
  }
  const validated = catalog.entries.map((entry) =>
    registryEntrySchema.parse(entry),
  );
  const plugins = validated
    .filter((entry) => entry.kind !== "app")
    .map((entry) => {
      const configKeys = Object.keys(entry.config);
      const pluginParameters = Object.fromEntries(
        Object.entries(entry.config).map(([key, field]) => [
          key,
          {
            type: field.type === "secret" ? "string" : field.type,
            description: field.help || field.label || key,
            required: field.required,
            sensitive: field.sensitive === true || field.type === "secret",
            ...(field.default !== undefined ? { default: field.default } : {}),
            ...(field.options
              ? { options: field.options.map((option) => option.value) }
              : {}),
          },
        ]),
      );
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        npmName: entry.npmName,
        ...(entry.npmName?.startsWith("@elizaos/plugin-")
          ? { dirName: entry.npmName.slice("@elizaos/".length) }
          : {}),
        version: entry.version,
        category:
          entry.kind === "connector"
            ? entry.subtype === "streaming"
              ? "streaming"
              : "connector"
            : ["ai-provider", "database"].includes(entry.subtype)
              ? entry.subtype
              : "feature",
        tags: entry.tags,
        configKeys,
        envKey: configKeys.find(
          (key) =>
            entry.config[key].autoEnableProvider ||
            entry.config[key].type === "secret",
        ),
        pluginParameters,
        configUiHints: entry.config,
        pluginDeps: entry.dependsOn,
        homepage: entry.resources.homepage,
        repository: entry.resources.repository,
        icon: entry.render.icon,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    $schema: "plugin-index-v1",
    generatedAt: new Date().toISOString(),
    count: plugins.length,
    plugins,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  try {
    const manifest = generatePluginIndex();
    console.log(
      `[generate-plugin-index] Generated ${manifest.count} first-party plugins`,
    );
  } catch (error) {
    // error-policy:J1 The CLI reports generation failure with a nonzero exit status.
    console.error(error);
    process.exitCode = 1;
  }
}
