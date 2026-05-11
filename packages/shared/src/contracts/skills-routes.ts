/**
 * Zod schemas for the skills HTTP routes — local skill management
 * (catalog install/uninstall, scaffold, edit, enable/disable,
 * marketplace surface).
 *
 * Routes covered (body-bearing only — no-body POSTs like
 * `/api/skills/refresh` and `/api/skills/catalog/refresh` need no
 * schema):
 *
 *   POST /api/skills/catalog/install
 *     body: { slug: string, version?: string }
 *   POST /api/skills/catalog/uninstall
 *     body: { slug: string }
 *   POST /api/skills/:id/acknowledge
 *     body: { enable?: boolean }
 *   POST /api/skills/create
 *     body: { name: string, description?: string }
 *   PUT  /api/skills/:id/source
 *     body: { content: string }
 *   POST /api/skills/marketplace/install
 *     body: { slug?, githubUrl?, repository?, path?, name?,
 *             description?, source?: 'clawhub'|'skillsmp'|'manual' }
 *     (refine: at least one of slug/githubUrl/repository required)
 *   POST /api/skills/marketplace/uninstall
 *     body: { id: string }
 *   PUT  /api/skills/marketplace/config
 *     body: { apiKey: string }
 */

import z from "zod";

export const PostSkillCatalogInstallRequestSchema = z
  .object({
    slug: z.string().regex(/\S/, "slug is required"),
    version: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    slug: value.slug.trim(),
    ...(value.version?.trim() ? { version: value.version.trim() } : {}),
  }));

export const PostSkillCatalogUninstallRequestSchema = z
  .object({
    slug: z.string().regex(/\S/, "slug is required"),
  })
  .strict()
  .transform((value) => ({
    slug: value.slug.trim(),
  }));

export const PostSkillAcknowledgeRequestSchema = z
  .object({
    enable: z.boolean().optional(),
  })
  .strict();

export const PostSkillCreateRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "name is required"),
    description: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    ...(value.description?.trim()
      ? { description: value.description.trim() }
      : {}),
  }));

export const PutSkillSourceRequestSchema = z
  .object({
    content: z.string(),
  })
  .strict();

const MarketplaceInstallSourceSchema = z.enum([
  "clawhub",
  "skillsmp",
  "manual",
]);

/**
 * Marketplace install accepts three mutually-exclusive identifying
 * inputs: slug (ClawHub-native install), githubUrl, or repository.
 * The route handler picks a path based on which is present, so the
 * schema only enforces the "at least one" invariant. Optional
 * descriptive fields are absorbed when whitespace-only.
 */
export const PostMarketplaceInstallRequestSchema = z
  .object({
    slug: z.string().optional(),
    githubUrl: z.string().optional(),
    repository: z.string().optional(),
    path: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    source: MarketplaceInstallSourceSchema.optional(),
  })
  .strict()
  .transform((value) => {
    const slug = value.slug?.trim();
    const githubUrl = value.githubUrl?.trim();
    const repository = value.repository?.trim();
    const pathField = value.path?.trim();
    const name = value.name?.trim();
    const description = value.description?.trim();
    return {
      ...(slug ? { slug } : {}),
      ...(githubUrl ? { githubUrl } : {}),
      ...(repository ? { repository } : {}),
      ...(pathField ? { path: pathField } : {}),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(value.source ? { source: value.source } : {}),
    };
  })
  .refine(
    (value) => Boolean(value.slug || value.githubUrl || value.repository),
    {
      message:
        "Install requires at least one of: slug, githubUrl, or repository",
    },
  );

export const PostMarketplaceUninstallRequestSchema = z
  .object({
    id: z.string().regex(/\S/, "id is required"),
  })
  .strict()
  .transform((value) => ({
    id: value.id.trim(),
  }));

export const PutMarketplaceConfigRequestSchema = z
  .object({
    apiKey: z.string().regex(/\S/, "apiKey is required"),
  })
  .strict()
  .transform((value) => ({
    apiKey: value.apiKey.trim(),
  }));

export type PostSkillCatalogInstallRequest = z.infer<
  typeof PostSkillCatalogInstallRequestSchema
>;
export type PostSkillCatalogUninstallRequest = z.infer<
  typeof PostSkillCatalogUninstallRequestSchema
>;
export type PostSkillAcknowledgeRequest = z.infer<
  typeof PostSkillAcknowledgeRequestSchema
>;
export type PostSkillCreateRequest = z.infer<
  typeof PostSkillCreateRequestSchema
>;
export type PutSkillSourceRequest = z.infer<typeof PutSkillSourceRequestSchema>;
export type PostMarketplaceInstallRequest = z.infer<
  typeof PostMarketplaceInstallRequestSchema
>;
export type PostMarketplaceUninstallRequest = z.infer<
  typeof PostMarketplaceUninstallRequestSchema
>;
export type PutMarketplaceConfigRequest = z.infer<
  typeof PutMarketplaceConfigRequestSchema
>;
export type MarketplaceInstallSource = z.infer<
  typeof MarketplaceInstallSourceSchema
>;
