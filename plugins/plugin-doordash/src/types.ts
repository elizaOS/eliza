/** Stable DoorDash operations and adapter capability types exposed by the plugin. */

export const DOORDASH_OPERATIONS = [
  "status",
  "set_address",
  "clear_session",
  "search",
  "menu",
  "add_to_cart",
  "remove_from_cart",
  "cart",
  "history",
  "preview_checkout",
  "place_order",
  "track_order",
] as const;

export type DoorDashOperation = (typeof DOORDASH_OPERATIONS)[number];

export interface DoorDashToolDescriptor {
  readonly inputSchema?: Record<string, unknown>;
  readonly name: string;
}

export interface DoorDashServerDescriptor {
  readonly name: string;
  readonly status: string;
  readonly tools?: DoorDashToolDescriptor[];
}

export interface DoorDashToolResult {
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
  }>;
  readonly isError?: boolean;
}

export interface DoorDashMcpService {
  getServers(): DoorDashServerDescriptor[];
  callTool(
    serverName: string,
    toolName: string,
    toolArguments?: Readonly<Record<string, unknown>>,
  ): Promise<DoorDashToolResult>;
}

export interface DoorDashCallResult {
  readonly serverName: string;
  readonly toolName: string;
  readonly value: unknown;
  readonly text: string;
}
