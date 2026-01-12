export const toolSelectionNameSchema = {
  type: "object",
  required: ["serverName", "toolName"],
  properties: {
    serverName: {
      type: "string",
      minLength: 1,
      errorMessage: "serverName must not be empty",
    },
    toolName: {
      type: "string",
      minLength: 1,
      errorMessage: "toolName must not be empty",
    },
    reasoning: {
      type: "string",
    },
    noToolAvailable: {
      type: "boolean",
    },
  },
} as const;

export interface ToolSelectionName {
  readonly serverName: string;
  readonly toolName: string;
  readonly reasoning?: string;
  readonly noToolAvailable?: boolean;
}

export const toolSelectionArgumentSchema = {
  type: "object",
  required: ["toolArguments"],
  properties: {
    toolArguments: {
      type: "object",
    },
  },
} as const;

export interface ToolSelectionArgument {
  readonly toolArguments: Readonly<Record<string, unknown>>;
}

export const ResourceSelectionSchema = {
  type: "object",
  required: ["serverName", "uri"],
  properties: {
    serverName: {
      type: "string",
      minLength: 1,
      errorMessage: "serverName must not be empty",
    },
    uri: {
      type: "string",
      minLength: 1,
      errorMessage: "uri must not be empty",
    },
    reasoning: {
      type: "string",
    },
    noResourceAvailable: {
      type: "boolean",
    },
  },
} as const;

export interface ResourceSelection {
  readonly serverName: string;
  readonly uri: string;
  readonly reasoning?: string;
  readonly noResourceAvailable?: boolean;
}

export function isToolSelectionName(value: unknown): value is ToolSelectionName {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.serverName === "string" &&
    obj.serverName.length > 0 &&
    typeof obj.toolName === "string" &&
    obj.toolName.length > 0
  );
}

export function isToolSelectionArgument(value: unknown): value is ToolSelectionArgument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.toolArguments === "object" && obj.toolArguments !== null;
}

export function isResourceSelection(value: unknown): value is ResourceSelection {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.serverName === "string" &&
    obj.serverName.length > 0 &&
    typeof obj.uri === "string" &&
    obj.uri.length > 0
  );
}
