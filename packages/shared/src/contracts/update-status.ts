import z from "zod";
import type { ReleaseChannel } from "./config.js";

export const ReleaseChannelSchema = z.enum(["stable", "beta", "nightly"]);

export const AgentInstallMethodSchema = z.enum([
  "npm-global",
  "bun-global",
  "homebrew",
  "snap",
  "apt",
  "flatpak",
  "local-dev",
  "unknown",
]);

export type AgentInstallMethod = z.infer<typeof AgentInstallMethodSchema>;

export type AgentUpdateAuthority =
  | "npm"
  | "bun"
  | "homebrew"
  | "snap"
  | "apt"
  | "flatpak"
  | "local-dev"
  | "unknown"
  | "package-manager"
  | "os-package-manager"
  | "developer"
  | "operator";

export const AgentUpdateAuthoritySchema = z.enum([
  "package-manager",
  "os-package-manager",
  "developer",
  "operator",
]);

export const AgentUpdateNextActionSchema = z.enum([
  "run-package-manager-command",
  "run-git-pull",
  "review-installation",
  "none",
]);

export type AgentUpdateNextAction = z.infer<typeof AgentUpdateNextActionSchema>;

export const AgentUpdateStatusSchema = z
  .object({
    currentVersion: z.string(),
    channel: ReleaseChannelSchema,
    installMethod: AgentInstallMethodSchema.or(z.string()),
    updateAuthority: AgentUpdateAuthoritySchema.optional(),
    nextAction: AgentUpdateNextActionSchema.optional(),
    canAutoUpdate: z.boolean().optional(),
    canExecuteUpdate: z.boolean().optional(),
    remoteDisplay: z.boolean().optional(),
    updateCommand: z.string().nullable().optional(),
    updateInstructions: z.string().optional(),
    updateAvailable: z.boolean(),
    latestVersion: z.string().nullable(),
    channels: z.record(ReleaseChannelSchema, z.string().nullable()),
    distTags: z.record(ReleaseChannelSchema, z.string()),
    lastCheckAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export interface AgentUpdateStatus {
  currentVersion: string;
  channel: ReleaseChannel;
  installMethod: AgentInstallMethod | (string & {});
  updateAuthority?: Extract<
    AgentUpdateAuthority,
    "package-manager" | "os-package-manager" | "developer" | "operator"
  >;
  nextAction?: AgentUpdateNextAction;
  canAutoUpdate?: boolean;
  canExecuteUpdate?: boolean;
  remoteDisplay?: boolean;
  updateCommand?: string | null;
  updateInstructions?: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  channels: Record<ReleaseChannel, string | null>;
  distTags: Record<ReleaseChannel, string>;
  lastCheckAt: string | null;
  error: string | null;
}
