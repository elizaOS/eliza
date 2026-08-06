import type { McpCatalogEntry } from "../mcp/catalog";
import type { McpRemoteTransport, McpServerConfig } from "../utils/settings";

export type McpBrowserRow =
  | { kind: "server"; server: McpServerConfig; description?: string }
  | { kind: "catalog"; entry: McpCatalogEntry }
  | { kind: "add" };

export type McpEditorField = "transport" | "label" | "url" | "headers" | "command" | "args" | "cwd" | "env";

export interface McpEditorDraft {
  label: string;
  transport: McpRemoteTransport | "stdio";
  url: string;
  headersText: string;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
}

export function createEmptyMcpEditorDraft(): McpEditorDraft {
  return {
    label: "",
    transport: "stdio",
    url: "",
    headersText: "",
    command: "",
    argsText: "",
    cwd: "",
    envText: "",
  };
}
