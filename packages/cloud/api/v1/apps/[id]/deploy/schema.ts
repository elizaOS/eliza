/**
 * Request schema for `POST /api/v1/apps/:id/deploy`.
 *
 * Lives in a sibling module so unit tests can import the schema without
 * pulling in the route's `@/lib/*` aliased imports (Bun's test runner does
 * not resolve TypeScript path aliases).
 */
import { z } from "zod";

export const DeployBodySchema = z.object({
  /** Explicit prebuilt image for this app deploy. The runner enforces the
   * platform + per-org namespace allowlist and optional digest-pin policy. */
  image: z.string().trim().min(1).max(1024).optional(),
  repoUrl: z.string().url().optional(),
  ref: z.string().min(1).max(255).optional(),
  dockerfile: z.string().min(1).max(255).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;
