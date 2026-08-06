export const LSP_TOOL_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

export type LspToolOperation = (typeof LSP_TOOL_OPERATIONS)[number];

export type LspBuiltInServerId =
  | "typescript"
  | "pyright"
  | "gopls"
  | "rust-analyzer"
  | "bash-language-server"
  | "yaml-language-server"
  | "clangd"
  | "jdtls"
  | "sourcekit-lsp";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  message: string;
  severity?: number;
  source?: string;
  code?: string;
  range: LspRange;
}

export interface LspDiagnosticFile {
  filePath: string;
  serverId: string;
  diagnostics: LspDiagnostic[];
}

export interface LspLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspBuiltInServerSettings {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  rootMarkers?: string[];
  extensions?: string[];
}

export interface LspCustomServerConfig {
  id: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  rootMarkers?: string[];
  extensions: string[];
  languageIds?: Record<string, string>;
}

export interface LspSettings {
  enabled?: boolean;
  tool?: boolean;
  autoInstall?: boolean;
  startupTimeoutMs?: number;
  diagnosticsDebounceMs?: number;
  builtins?: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>>;
  servers?: LspCustomServerConfig[];
}

export interface NormalizedLspSettings {
  enabled: boolean;
  tool: boolean;
  autoInstall: boolean;
  startupTimeoutMs: number;
  diagnosticsDebounceMs: number;
  builtins: Partial<Record<LspBuiltInServerId, LspBuiltInServerSettings>>;
  servers: LspCustomServerConfig[];
}

export interface LspQueryInput {
  operation: LspToolOperation;
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

export interface LspToolResponse {
  success: boolean;
  output: string;
  lspDiagnostics?: LspDiagnosticFile[];
}
