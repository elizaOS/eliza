import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ComputerUseMode = "auto" | "local" | "mcp";

export const computerUseConfigSchema = z.object({
  COMPUTERUSE_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  COMPUTERUSE_MODE: z.enum(["auto", "local", "mcp"]).optional().default("auto"),
  COMPUTERUSE_MCP_SERVER: z.string().optional().default("computeruse"),
});

export type ComputerUseConfig = z.infer<typeof computerUseConfigSchema>;

export type ComputerUseBackendName = "local" | "mcp";

export interface ComputerUseOpenApplicationInput {
  readonly name: string;
}

export interface ComputerUseClickInput {
  readonly process?: string;
  readonly selector: string;
  readonly timeoutMs: number;
}

export interface ComputerUseTypeInput {
  readonly process?: string;
  readonly selector: string;
  readonly text: string;
  readonly timeoutMs: number;
  readonly clearBeforeTyping: boolean;
}

export interface ComputerUseGetWindowTreeInput {
  readonly process: string;
  readonly title?: string;
  readonly maxDepth?: number;
}
