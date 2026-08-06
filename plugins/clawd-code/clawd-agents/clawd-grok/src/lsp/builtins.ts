import { access } from "fs/promises";
import path from "path";
import { lspNpmWhich } from "./npm-cache";
import type { LspBuiltInServerId, LspCustomServerConfig, LspLaunchSpec, NormalizedLspSettings } from "./types";

export interface RuntimeLspServerDefinition {
  id: string;
  extensions: string[];
  languageIds: Record<string, string>;
  resolveRoot(filePath: string, cwd: string): Promise<string | null>;
  resolveLaunch(root: string, settings: NormalizedLspSettings): Promise<LspLaunchSpec | null>;
}

interface BuiltInDefinition {
  id: LspBuiltInServerId;
  extensions: string[];
  languageIds: Record<string, string>;
  rootMarkers: string[];
  resolveLaunch(root: string, settings: NormalizedLspSettings): Promise<LspLaunchSpec | null>;
}

const LOCKFILE_MARKERS = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

const BUILT_IN_DEFINITIONS: Record<LspBuiltInServerId, BuiltInDefinition> = {
  typescript: {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".mts": "typescript",
      ".cts": "typescript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ...LOCKFILE_MARKERS],
    async resolveLaunch(root, settings) {
      const override = settings.builtins.typescript;
      const resolved =
        override?.command && override?.args
          ? { command: override.command, args: override.args }
          : await resolveNodeServerLaunch(
              root,
              "typescript-language-server",
              "typescript-language-server",
              ["--stdio"],
              settings.autoInstall,
            );
      if (!resolved && !override?.command) return null;
      const tsserver = await resolveTypeScriptServer(root);
      return {
        command: override?.command ?? resolved?.command ?? "",
        args: override?.args ?? resolved?.args ?? ["--stdio"],
        env: override?.env,
        initializationOptions: {
          ...(tsserver ? { tsserver: { path: tsserver } } : {}),
          ...override?.initialization,
        },
      };
    },
  },
  pyright: {
    id: "pyright",
    extensions: [".py", ".pyi"],
    languageIds: {
      ".py": "python",
      ".pyi": "python",
    },
    rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", ".venv", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins.pyright;
      const resolved =
        override?.command && override?.args
          ? { command: override.command, args: override.args }
          : (await resolveNodeServerLaunch(root, "pyright-langserver", "pyright", ["--stdio"], settings.autoInstall)) ||
            (await resolveNodeServerLaunch(
              root,
              "basedpyright-langserver",
              "basedpyright",
              ["--stdio"],
              settings.autoInstall,
            ));
      if (!resolved && !override?.command) return null;
      return {
        command: override?.command ?? resolved?.command ?? "",
        args: override?.args ?? resolved?.args ?? ["--stdio"],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  gopls: {
    id: "gopls",
    extensions: [".go"],
    languageIds: {
      ".go": "go",
    },
    rootMarkers: ["go.work", "go.mod", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins.gopls;
      const command = override?.command || (await resolveCommand(root, "gopls"));
      if (!command) return null;
      return {
        command,
        args: override?.args ?? [],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  "rust-analyzer": {
    id: "rust-analyzer",
    extensions: [".rs"],
    languageIds: {
      ".rs": "rust",
    },
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins["rust-analyzer"];
      const command = override?.command || (await resolveCommand(root, "rust-analyzer"));
      if (!command) return null;
      return {
        command,
        args: override?.args ?? [],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  "bash-language-server": {
    id: "bash-language-server",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    languageIds: {
      ".sh": "shellscript",
      ".bash": "shellscript",
      ".zsh": "shellscript",
      ".ksh": "shellscript",
    },
    rootMarkers: [".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins["bash-language-server"];
      const resolved =
        override?.command && override?.args
          ? { command: override.command, args: override.args }
          : await resolveNodeServerLaunch(
              root,
              "bash-language-server",
              "bash-language-server",
              ["start"],
              settings.autoInstall,
            );
      if (!resolved && !override?.command) return null;
      return {
        command: override?.command ?? resolved?.command ?? "",
        args: override?.args ?? resolved?.args ?? ["start"],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  "yaml-language-server": {
    id: "yaml-language-server",
    extensions: [".yaml", ".yml"],
    languageIds: {
      ".yaml": "yaml",
      ".yml": "yaml",
    },
    rootMarkers: [".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins["yaml-language-server"];
      const resolved =
        override?.command && override?.args
          ? { command: override.command, args: override.args }
          : await resolveNodeServerLaunch(
              root,
              "yaml-language-server",
              "yaml-language-server",
              ["--stdio"],
              settings.autoInstall,
            );
      if (!resolved && !override?.command) return null;
      return {
        command: override?.command ?? resolved?.command ?? "",
        args: override?.args ?? resolved?.args ?? ["--stdio"],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  clangd: {
    id: "clangd",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    languageIds: {
      ".c": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".h": "c",
      ".hh": "cpp",
      ".hpp": "cpp",
      ".hxx": "cpp",
    },
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins.clangd;
      const command = override?.command || (await resolveCommand(root, "clangd"));
      if (!command) return null;
      return {
        command,
        args: override?.args ?? [],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  jdtls: {
    id: "jdtls",
    extensions: [".java"],
    languageIds: {
      ".java": "java",
    },
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins.jdtls;
      const command = override?.command || (await resolveCommand(root, "jdtls"));
      if (!command) return null;
      return {
        command,
        args: override?.args ?? [],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
  "sourcekit-lsp": {
    id: "sourcekit-lsp",
    extensions: [".swift"],
    languageIds: {
      ".swift": "swift",
    },
    rootMarkers: ["Package.swift", ".git"],
    async resolveLaunch(root, settings) {
      const override = settings.builtins["sourcekit-lsp"];
      const command = override?.command || (await resolveCommand(root, "sourcekit-lsp"));
      if (!command) return null;
      return {
        command,
        args: override?.args ?? [],
        env: override?.env,
        initializationOptions: override?.initialization,
      };
    },
  },
};

export function createRuntimeLspDefinitions(
  cwd: string,
  settings: NormalizedLspSettings,
): RuntimeLspServerDefinition[] {
  const definitions: RuntimeLspServerDefinition[] = [];

  for (const definition of Object.values(BUILT_IN_DEFINITIONS)) {
    const override = settings.builtins[definition.id];
    if (override?.enabled === false) continue;
    definitions.push({
      id: definition.id,
      extensions: normalizeExtensions(override?.extensions ?? definition.extensions),
      languageIds: definition.languageIds,
      resolveRoot: async (filePath) => findNearestRoot(filePath, cwd, override?.rootMarkers ?? definition.rootMarkers),
      resolveLaunch: async (root, normalizedSettings) => {
        const launch = await definition.resolveLaunch(root, normalizedSettings);
        if (!launch) return null;
        return {
          ...launch,
          env: {
            ...(launch.env ?? {}),
            ...(override?.env ?? {}),
          },
          initializationOptions: {
            ...(launch.initializationOptions ?? {}),
            ...(override?.initialization ?? {}),
          },
        };
      },
    });
  }

  for (const custom of settings.servers) {
    if (custom.enabled === false) continue;
    definitions.push(createCustomRuntimeDefinition(cwd, custom));
  }

  return definitions;
}

function createCustomRuntimeDefinition(cwd: string, config: LspCustomServerConfig): RuntimeLspServerDefinition {
  return {
    id: config.id,
    extensions: normalizeExtensions(config.extensions),
    languageIds:
      config.languageIds ?? Object.fromEntries(config.extensions.map((extension) => [extension, extension.slice(1)])),
    resolveRoot: async (filePath) => findNearestRoot(filePath, cwd, config.rootMarkers ?? [".git"]),
    resolveLaunch: async () => ({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      initializationOptions: config.initialization,
    }),
  };
}

async function resolveCommand(root: string, binary: string): Promise<string | null> {
  const localBinary = await findLocalBinary(root, binary);
  if (localBinary) return localBinary;
  return findCommandOnPath(binary);
}

async function resolveTypeScriptServer(root: string): Promise<string | null> {
  const modulePath = path.join("node_modules", "typescript", "lib", "tsserver.js");
  let current = root;

  while (true) {
    const candidate = path.join(current, modulePath);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function findLocalBinary(root: string, binary: string): Promise<string | null> {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(root, "node_modules", ".bin", `${binary}${ext}`);
  return (await pathExists(candidate)) ? candidate : null;
}

async function resolveNodeServerLaunch(
  root: string,
  binary: string,
  packageName: string,
  baseArgs: string[],
  autoInstall: boolean,
): Promise<{ command: string; args: string[] } | null> {
  const command = await resolveCommand(root, binary);
  if (command) {
    return { command, args: baseArgs };
  }

  if (!autoInstall) return null;

  const cached = await lspNpmWhich(packageName);
  if (cached) {
    return { command: cached, args: baseArgs };
  }

  return null;
}

async function findCommandOnPath(binary: string): Promise<string | null> {
  const pathValue = process.env.PATH;
  if (!pathValue) return null;

  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const segment of pathValue.split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(segment, `${binary}${suffix}`);
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findNearestRoot(filePath: string, cwd: string, markers: string[]): Promise<string | null> {
  const normalizedMarkers = markers.length > 0 ? markers : [".git"];
  let current = path.dirname(path.resolve(filePath));
  const stop = path.resolve(cwd);

  while (true) {
    for (const marker of normalizedMarkers) {
      if (await pathExists(path.join(current, marker))) return current;
    }
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return stop;
}

function normalizeExtensions(extensions: string[]): string[] {
  return extensions.map((extension) =>
    extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
  );
}
