/**
 * Request schema for `POST /api/v1/apps/:id/deploy`.
 *
 * Lives in a sibling module so unit tests can import the schema without
 * pulling in the route's `@/lib/*` aliased imports (Bun's test runner does
 * not resolve TypeScript path aliases).
 */

import { canonicalizeAppBuildRepoUrl } from "@elizaos/cloud-shared/lib/security/app-build-repo-url.ts";
import { z } from "zod";

const CanonicalBuildRepositorySchema = z
  .string()
  .transform((value, context) => {
    try {
      return canonicalizeAppBuildRepoUrl(value);
    } catch {
      // error-policy:J3 untrusted-input sanitizing; expose an invalid schema result without trusting the rejected URL.
      context.addIssue({
        code: "custom",
        message:
          "Use an HTTPS github.com owner/repository URL without credentials or redirects",
      });
      return z.NEVER;
    }
  });

export const DeployBodySchema = z.object({
  repoUrl: CanonicalBuildRepositorySchema.optional(),
  ref: z.string().min(1).max(255).optional(),
  dockerfile: z.string().min(1).max(255).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;
