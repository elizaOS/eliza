import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import {
  readTailscaleAccounts,
  resolveTailscaleAccount,
  resolveTailscaleAccountId,
} from "./accounts";

export const tailscaleEnvSchema = z.object({
  TAILSCALE_AUTH_KEY: z.string().optional(),
  TAILSCALE_TAGS: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) return value.filter((tag) => tag.length > 0);
      if (typeof value === "string" && value.length > 0)
        return value
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      return ["tag:eliza-tunnel"];
    })
    .default(["tag:eliza-tunnel"]),
  TAILSCALE_FUNNEL: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1")
    .default(false),
  TAILSCALE_DEFAULT_PORT: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return 3000;
      const num =
        typeof value === "string" ? Number.parseInt(value, 10) : value;
      if (Number.isNaN(num) || num <= 0 || num > 65535) return 3000;
      return num;
    })
    .default(3000),
  TAILSCALE_BACKEND: z
    .enum(["local", "cloud", "auto"])
    .optional()
    .default("auto"),
  TAILSCALE_AUTH_KEY_EXPIRY_SECONDS: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return 3600;
      const num =
        typeof value === "string" ? Number.parseInt(value, 10) : value;
      if (Number.isNaN(num) || num <= 0) return 3600;
      return num;
    })
    .default(3600),
});

export type TailscaleConfig = z.infer<typeof tailscaleEnvSchema>;

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export async function validateTailscaleConfig(
  runtime: IAgentRuntime,
  accountId?: string,
): Promise<TailscaleConfig> {
  const resolvedAccountId = accountId ?? resolveTailscaleAccountId(runtime);
  const account = resolveTailscaleAccount(
    readTailscaleAccounts(runtime),
    resolvedAccountId,
  );
  const config = {
    TAILSCALE_AUTH_KEY:
      account?.authKey ??
      readSetting(runtime, "TAILSCALE_AUTH_KEY") ??
      process.env.TAILSCALE_AUTH_KEY,
    TAILSCALE_TAGS:
      account?.tags ??
      readSetting(runtime, "TAILSCALE_TAGS") ??
      process.env.TAILSCALE_TAGS,
    TAILSCALE_FUNNEL:
      account?.funnel ??
      readSetting(runtime, "TAILSCALE_FUNNEL") ??
      process.env.TAILSCALE_FUNNEL,
    TAILSCALE_DEFAULT_PORT:
      account?.defaultPort ??
      readSetting(runtime, "TAILSCALE_DEFAULT_PORT") ??
      process.env.TAILSCALE_DEFAULT_PORT,
    TAILSCALE_BACKEND:
      account?.backend ??
      readSetting(runtime, "TAILSCALE_BACKEND") ??
      process.env.TAILSCALE_BACKEND,
    TAILSCALE_AUTH_KEY_EXPIRY_SECONDS:
      account?.authKeyExpirySeconds ??
      readSetting(runtime, "TAILSCALE_AUTH_KEY_EXPIRY_SECONDS") ??
      process.env.TAILSCALE_AUTH_KEY_EXPIRY_SECONDS,
  };
  return tailscaleEnvSchema.parse(config);
}
