/**
 * Zod schemas for the skills HTTP routes: local skill management, direct
 * GitHub installation, scaffold, edit, and enable/disable operations.
 *
 * Routes covered (body-bearing only; `/api/skills/refresh` has no body):
 *
 *   POST /api/skills/install
 *     body: { githubUrl: string }
 *   POST /api/skills/:id/acknowledge
 *     body: { enable?: boolean }
 *   POST /api/skills/create
 *     body: { name: string, description?: string }
 *   PUT  /api/skills/:id/source
 *     body: { content: string }
 */

import z from "zod";

export const PostSkillInstallRequestSchema = z
  .object({
    githubUrl: z
      .string()
      .trim()
      .url("githubUrl must be a valid URL")
      .refine((value) => new URL(value).hostname === "github.com", {
        message: "githubUrl must use github.com",
      }),
  })
  .strict()
  .transform((value) => ({ githubUrl: value.githubUrl }));

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

export type PostSkillInstallRequest = z.infer<
  typeof PostSkillInstallRequestSchema
>;
export type PostSkillAcknowledgeRequest = z.infer<
  typeof PostSkillAcknowledgeRequestSchema
>;
export type PostSkillCreateRequest = z.infer<
  typeof PostSkillCreateRequestSchema
>;
export type PutSkillSourceRequest = z.infer<typeof PutSkillSourceRequestSchema>;
