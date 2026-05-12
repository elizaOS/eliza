import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  getInstalledPackageEntry,
  resolveModuleEntry,
} from "../eliza-package-paths";

/** Vite rollup alias shape; structural type avoids duplicate vite versions in Bun's typings. */
export type ModuleAlias = {
  find: string | RegExp;
  replacement: string;
};

type FallbackAliasOptions = {
  fallbackReplacement?: string;
};

type ElizaAliasOptions = {
  includeElizaAlias?: boolean;
};

export type AgentSourceAliasOptions = FallbackAliasOptions & ElizaAliasOptions;

export type AppCoreSourceAliasOptions = FallbackAliasOptions & {
  bridgeReplacement?: string;
  stubRootSpecifier?: boolean;
};

export type SharedSourceAliasOptions = ElizaAliasOptions & {
  includeConfigAlias?: boolean;
};

export type InstalledPackageAliasOptions = {
  entryKind?: "node";
  fallbackPath?: string;
};

type WorkspacePackageManifest = {
  exports?: Record<string, unknown>;
};

export function getElizaWorkspaceRoot(repoRoot: string): string {
  const nestedElizaRoot = path.join(repoRoot, "eliza");
  return existsSync(path.join(nestedElizaRoot, "package.json")) &&
    existsSync(path.join(nestedElizaRoot, "packages"))
    ? nestedElizaRoot
    : repoRoot;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWorkspacePackageManifest(
  packageRoot: string,
): WorkspacePackageManifest | null {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as WorkspacePackageManifest;
  } catch {
    return null;
  }
}

function resolveExportTarget(exportTarget: unknown): string | undefined {
  if (typeof exportTarget === "string") {
    return exportTarget;
  }

  if (!exportTarget || typeof exportTarget !== "object") {
    return undefined;
  }

  const record = exportTarget as Record<string, unknown>;
  for (const key of ["bun", "import", "default", "types"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

function getWorkspacePackageExportAliases(
  packageName: string,
  packageRoot: string,
): ModuleAlias[] {
  const manifest = readWorkspacePackageManifest(packageRoot);
  const exportsMap = manifest?.exports;
  if (!exportsMap) {
    return [];
  }

  return Object.entries(exportsMap).flatMap(([subpath, exportTarget]) => {
    if (
      subpath === "." ||
      subpath === "./package.json" ||
      subpath.includes("*")
    ) {
      return [];
    }

    const target = resolveExportTarget(exportTarget);
    if (!target) {
      return [];
    }

    const replacement = path.join(packageRoot, target);
    if (!existsSync(replacement)) {
      return [];
    }

    return [
      {
        find: new RegExp(
          `^@elizaos/${escapeRegExp(packageName)}/${escapeRegExp(
            subpath.slice(2),
          )}$`,
        ),
        replacement,
      },
    ];
  });
}

function getPackageSourceAliases(
  packageName: string,
  sourceRoot: string,
  {
    includeElizaAlias = false,
    rootReplacement,
  }: {
    includeElizaAlias?: boolean;
    rootReplacement: string;
  },
	): ModuleAlias[] {
  return [
    ...(includeElizaAlias
      ? [
          {
            find: `@elizaai/${packageName}`,
            replacement: rootReplacement,
          },
        ]
      : []),
    {
      find: `@elizaos/${packageName}`,
      replacement: rootReplacement,
    },
  ];
}

export function getOptionalResolvedAliases(
  aliases: ReadonlyArray<{
    find: ModuleAlias["find"];
    replacement?: string | null;
  }>,
): ModuleAlias[] {
  return aliases.flatMap(({ find, replacement }) =>
    replacement && existsSync(replacement) ? [{ find, replacement }] : [],
  );
}

export function getOptionalInstalledPackageAliases(
  repoRoot: string,
  aliases: ReadonlyArray<{
    find: ModuleAlias["find"];
    packageName: string;
    options?: InstalledPackageAliasOptions;
  }>,
): ModuleAlias[] {
  return aliases.flatMap(({ find, packageName, options }) => {
    const installedEntry = getInstalledPackageEntry(
      packageName,
      repoRoot,
      options?.entryKind,
    );

    if (installedEntry) {
      return [{ find, replacement: installedEntry }];
    }

    return options?.fallbackPath
      ? [{ find, replacement: resolveModuleEntry(options.fallbackPath) }]
      : [];
  });
}

export function getElizaCoreRolesEntry(repoRoot: string): string {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  const elizaCoreRolesSource = path.join(
    elizaWorkspaceRoot,
    "packages",
    "typescript",
    "src",
    "roles.ts",
  );

  return existsSync(elizaCoreRolesSource)
    ? elizaCoreRolesSource
    : path.join(
        elizaWorkspaceRoot,
        "packages",
        "app-core",
        "scripts",
        "lib",
        "elizaos-core-roles-shim.js",
      );
}

export function getAppCoreBridgeStubPath(repoRoot: string): string {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  return path.join(
    elizaWorkspaceRoot,
    "packages",
    "app-core",
    "test",
    "stubs",
    "app-core-bridge.ts",
  );
}

export function getAppCorePluginFallbackPath(repoRoot: string): string {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  return path.join(
    elizaWorkspaceRoot,
    "packages",
    "app-core",
    "test",
    "stubs",
    "plugin-fallback-module.mjs",
  );
}

export function getAppCoreModuleFallbackPath(repoRoot: string): string {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  return path.join(
    elizaWorkspaceRoot,
    "packages",
    "app-core",
    "test",
    "stubs",
    "module-fallback.mjs",
  );
}

export function getOptionalPluginSdkAliases(repoRoot: string): ModuleAlias[] {
  const pluginSdkEntry = path.join(repoRoot, "src", "plugin-sdk", "index.ts");

  return existsSync(pluginSdkEntry)
    ? [{ find: "eliza/plugin-sdk", replacement: pluginSdkEntry }]
    : [];
}

export function getAgentSourceAliases(
  sourceRoot: string | undefined,
  options: AgentSourceAliasOptions = {},
): ModuleAlias[] {
  if (sourceRoot) {
    return getPackageSourceAliases("agent", sourceRoot, {
      includeElizaAlias: options.includeElizaAlias,
      rootReplacement: resolveModuleEntry(path.join(sourceRoot, "index")),
    });
  }

  return options.fallbackReplacement
    ? [
        {
          find: /^@elizaos\/agent$/,
          replacement: options.fallbackReplacement,
        },
      ]
    : [];
}

export function getAppCoreSourceAliases(
  sourceRoot: string | undefined,
  options: AppCoreSourceAliasOptions = {},
): ModuleAlias[] {
  if (sourceRoot) {
    const bridgeReplacement = options.bridgeReplacement;

    return [
      ...(bridgeReplacement
        ? [
            ...(options.stubRootSpecifier
              ? [
                  {
                    find: /^@elizaos\/app-core$/,
                    replacement: bridgeReplacement,
                  },
                ]
              : []),
          ]
        : []),
      ...(!options.stubRootSpecifier
        ? [
            {
              find: "@elizaos/app-core",
              replacement: resolveModuleEntry(path.join(sourceRoot, "index")),
            },
          ]
        : []),
    ];
  }

  return options.fallbackReplacement
    ? [
        {
          find: /^@elizaos\/app-core$/,
          replacement: options.fallbackReplacement,
        },
      ]
    : [];
}

export function getSharedSourceAliases(
  sourceRoot: string | undefined,
  options: SharedSourceAliasOptions = {},
): ModuleAlias[] {
  if (!sourceRoot) {
    return [];
  }

  const packageRoot = path.dirname(sourceRoot);

  return [
    ...getWorkspacePackageExportAliases("shared", packageRoot),
    ...getPackageSourceAliases("shared", sourceRoot, {
      includeElizaAlias: options.includeElizaAlias,
      rootReplacement: path.join(sourceRoot, "index.ts"),
    }),
  ];
}

export function getUiSourceAliases(
  sourceRoot: string | undefined,
): ModuleAlias[] {
  if (!sourceRoot) {
    return [];
  }

  return getPackageSourceAliases("ui", sourceRoot, {
    includeElizaAlias: true,
    rootReplacement: resolveModuleEntry(path.join(sourceRoot, "index")),
  });
}

export function getWorkspaceAppAliases(
  repoRoot: string,
  appNames: string[],
): ModuleAlias[] {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  return appNames.flatMap((appName) => {
    const candidates = [
      path.join(elizaWorkspaceRoot, "apps", appName),
      path.join(elizaWorkspaceRoot, "plugins", appName),
    ];

    for (const appRoot of candidates) {
      const appSourceRoot = path.join(appRoot, "src");
      const appEntry = path.join(appSourceRoot, "index.ts");

      if (!existsSync(appEntry)) {
        continue;
      }

      return [
        ...getWorkspacePackageExportAliases(appName, appRoot),
        ...getPackageSourceAliases(appName, appSourceRoot, {
          rootReplacement: appEntry,
        }),
      ];
    }

    return [];
  });
}

export function getWorkspacePluginAliases(
  repoRoot: string,
  pluginNames: string[],
): ModuleAlias[] {
  const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
  return pluginNames.flatMap((pluginName) => {
    const pluginRoot = path.join(elizaWorkspaceRoot, "plugins", pluginName);
    const candidates = [
      {
        packageRoot: pluginRoot,
        sourceRoot: path.join(pluginRoot, "src"),
      },
      {
        packageRoot: pluginRoot,
        sourceRoot: pluginRoot,
      },
      {
        packageRoot: path.join(pluginRoot, "typescript"),
        sourceRoot: path.join(pluginRoot, "typescript", "src"),
      },
    ];

    for (const { packageRoot, sourceRoot } of candidates) {
      const pluginEntry = path.join(sourceRoot, "index.ts");
      if (!existsSync(pluginEntry)) {
        continue;
      }

      return [
        ...getWorkspacePackageExportAliases(pluginName, packageRoot),
        ...getPackageSourceAliases(pluginName, sourceRoot, {
          rootReplacement: pluginEntry,
        }),
      ];
    }

    return [];
  });
}
