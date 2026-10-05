/** Browser- and edge-safe structural MCP protocol types shared by runtime hosts. */

export interface McpKernelTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpKernelResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpKernelServer {
  readonly name: string;
  readonly status: string;
  readonly tools?: readonly McpKernelTool[];
  readonly resources?: readonly McpKernelResource[];
}

export interface McpKernelProviderData {
  readonly [serverName: string]: {
    readonly status: string;
    readonly tools: Readonly<
      Record<
        string,
        {
          readonly description: string;
          readonly inputSchema?: Readonly<Record<string, unknown>>;
        }
      >
    >;
    readonly resources: Readonly<
      Record<
        string,
        {
          readonly name: string;
          readonly description: string;
          readonly mimeType?: string;
        }
      >
    >;
  };
}

export interface McpKernelProviderProjection {
  readonly values: {
    readonly mcp: McpKernelProviderData;
    readonly mcpText?: string;
  };
  readonly data: { readonly mcp: McpKernelProviderData };
  readonly text: string;
}
