/**
 * Zod schemas for the plugin HTTP routes — config + install / update /
 * uninstall surface plus secrets and core-plugin toggle.
 *
 * Routes covered (body-bearing only — eject/sync/reinject/test take
 * no body):
 *
 *   PUT  /api/plugins/:id
 *     body: { enabled?: boolean, config?: Record<string, string> }
 *   PUT  /api/secrets
 *     body: { secrets: Record<string, string> }
 *   POST /api/plugins/install
 *     body: { name, autoRestart?, stream?: 'latest'|'beta', version? }
 *   POST /api/plugins/update
 *     body: same as install
 *   POST /api/plugins/uninstall
 *     body: { name, autoRestart? }
 *   POST /api/plugins/core/toggle
 *     body: { npmName, enabled }
 *   PUT  /api/skills/curated/:name/source
 *     body: { content: string }
 */

import z from "zod";

export const PutPluginRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const PutSecretsRequestSchema = z
  .object({
    secrets: z.record(z.string(), z.string()),
  })
  .strict();

const PluginInstallStreamSchema = z.enum(["latest", "beta"]);

const BasePluginInstallRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "name is required"),
    autoRestart: z.boolean().optional(),
    stream: PluginInstallStreamSchema.optional(),
    version: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    ...(value.autoRestart !== undefined
      ? { autoRestart: value.autoRestart }
      : {}),
    ...(value.stream ? { stream: value.stream } : {}),
    ...(value.version?.trim() ? { version: value.version.trim() } : {}),
  }));

export const PostPluginInstallRequestSchema = BasePluginInstallRequestSchema;
export const PostPluginUpdateRequestSchema = BasePluginInstallRequestSchema;

export const PostPluginUninstallRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "name is required"),
    autoRestart: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    ...(value.autoRestart !== undefined
      ? { autoRestart: value.autoRestart }
      : {}),
  }));

export const PostPluginCoreToggleRequestSchema = z
  .object({
    npmName: z.string().regex(/\S/, "npmName is required"),
    enabled: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    npmName: value.npmName.trim(),
    enabled: value.enabled,
  }));

export const PutCuratedSkillSourceRequestSchema = z
  .object({
    content: z.string(),
  })
  .strict();

export type PutPluginRequest = z.infer<typeof PutPluginRequestSchema>;
export type PutSecretsRequest = z.infer<typeof PutSecretsRequestSchema>;
export type PostPluginInstallRequest = z.infer<
  typeof PostPluginInstallRequestSchema
>;
export type PostPluginUpdateRequest = z.infer<
  typeof PostPluginUpdateRequestSchema
>;
export type PostPluginUninstallRequest = z.infer<
  typeof PostPluginUninstallRequestSchema
>;
export type PostPluginCoreToggleRequest = z.infer<
  typeof PostPluginCoreToggleRequestSchema
>;
export type PutCuratedSkillSourceRequest = z.infer<
  typeof PutCuratedSkillSourceRequestSchema
>;
export type PluginInstallStream = z.infer<typeof PluginInstallStreamSchema>;
