/**
 * Request schema for `POST /api/v1/apps/:id/deploy`.
 *
 * Lives in a sibling module so unit tests can import the schema without
 * pulling in the route's `@/lib/*` aliased imports (Bun's test runner does
 * not resolve TypeScript path aliases).
 */
import { z } from "zod";

export const DeployBodySchema = z.object({
  repoUrl: z.string().url().optional(),
  ref: z.string().min(1).max(255).optional(),
  dockerfile: z.string().min(1).max(255).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;
