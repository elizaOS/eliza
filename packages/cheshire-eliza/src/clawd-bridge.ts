/**
 * Monorepo path map connecting Cheshire elizaOS packages to Clawd Code.
 * Clawd Code is a CLI submodule (not an @elizaos plugin); eliza plugins remain separate.
 */

/** Upstream CLI package (git submodule at plugins/clawd-code) */
export const CLAWD_CODE_GITHUB = "https://github.com/Solizardking/clawd-code";

/** Installer entrypoint for operators outside the monorepo */
export const CLAWD_CODE_INSTALL_SH =
  "https://raw.githubusercontent.com/Solizardking/clawd-code/main/install.sh";

/** Relative monorepo paths (repo root) */
export const CLAWD_MONOREPO_PATHS = {
  clawdCode: "plugins/clawd-code",
  clawdPlugin: "plugins/clawd-plugin",
  cheshireEliza: "packages/cheshire-eliza",
  pluginCheshireMemory: "plugins/plugin-cheshire-memory",
  pluginClawdBrowser: "plugins/plugin-clawdbrowser",
  pluginDflowTrade: "plugins/plugin-dflow-trade",
} as const;

/** npm / workspace package names */
export const CLAWD_PACKAGE_NAMES = {
  code: "@solana-clawd/clawd-code",
  plugin: "@solana-clawd/clawd-plugin",
  cheshireEliza: "@elizaos/cheshire-eliza",
  memory: "@elizaos/plugin-cheshire-memory",
  clawdBrowser: "@elizaos/plugin-clawdbrowser",
  dflowTrade: "@elizaos/plugin-dflow-trade",
} as const;

/**
 * Documented integration edges for agents and PR checklists.
 * Direction is "consumer → dependency".
 */
export const CLAWD_INTEGRATION_EDGES = [
  {
    from: CLAWD_PACKAGE_NAMES.plugin,
    to: CLAWD_PACKAGE_NAMES.code,
    via: "plugins/clawd-plugin/scripts/run-clawd-code.mjs → sibling plugins/clawd-code",
  },
  {
    from: CLAWD_PACKAGE_NAMES.cheshireEliza,
    to: CLAWD_PACKAGE_NAMES.memory,
    via: "character + body-generator plugin lists",
  },
  {
    from: CLAWD_PACKAGE_NAMES.cheshireEliza,
    to: CLAWD_PACKAGE_NAMES.clawdBrowser,
    via: "character + body-generator plugin lists",
  },
  {
    from: CLAWD_PACKAGE_NAMES.cheshireEliza,
    to: CLAWD_PACKAGE_NAMES.code,
    via: "operator docs + CLAWD_* path constants (CLI companion, not Plugin load)",
  },
  {
    from: CLAWD_PACKAGE_NAMES.clawdBrowser,
    to: "ClawdBrowser tools.md",
    via: "CLAWDBROWSER_TOOLS_MD / catalog service",
  },
] as const;

/** Operator-facing summary for README / system prompts */
export function clawdStackSummary(): string {
  return [
    `Clawd Code CLI: ${CLAWD_CODE_GITHUB} (monorepo path ${CLAWD_MONOREPO_PATHS.clawdCode})`,
    `Clawd plugin: ${CLAWD_MONOREPO_PATHS.clawdPlugin} (MCP bridge to the CLI)`,
    `Install: curl -fsSL ${CLAWD_CODE_INSTALL_SH} | sh`,
    `Eliza companions: ${CLAWD_PACKAGE_NAMES.memory}, ${CLAWD_PACKAGE_NAMES.clawdBrowser}, ${CLAWD_PACKAGE_NAMES.dflowTrade}`,
  ].join("\n");
}
