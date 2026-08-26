/**
 * Super-admin boundary for resolving duplicate existing personal Dedicated
 * inventory without provisioning, billing, cutover, or deleting any row.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  PersonalDedicatedSelectionError,
  personalDedicatedAdoptionSelectionService,
} from "@/lib/services/personal-dedicated-adoption-selection";
import { personalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const commonRequest = {
  action: z.literal("select_existing_personal_dedicated"),
  targetOwnerOrganizationId: z.string().uuid(),
  targetOwnerUserId: z.string().uuid(),
  retainedAgentId: z.string().uuid(),
  reason: z.literal("duplicate_owned_dedicated_inventory"),
};

const previewRequestSchema = z
  .object({
    ...commonRequest,
    dryRun: z.literal(true),
  })
  .strict();

const executeRequestSchema = z
  .object({
    ...commonRequest,
    dryRun: z.literal(false),
    inventoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    stateDisposition: z.enum([
      "verified_backup_present",
      "fresh_boot_no_verified_backup",
    ]),
    confirmation: z.literal("select_without_provisioning_or_deleting"),
  })
  .strict();

const requestSchema = z.union([previewRequestSchema, executeRequestSchema]);

interface AdminPersonalDedicatedSelectionRouteDependencies {
  requireAdmin: typeof requireAdmin;
  selectionService: Pick<
    typeof personalDedicatedAdoptionSelectionService,
    "preview" | "execute"
  >;
  logger: Pick<typeof logger, "info">;
}

const defaultDependencies: AdminPersonalDedicatedSelectionRouteDependencies = {
  requireAdmin,
  selectionService: personalDedicatedAdoptionSelectionService,
  logger,
};

function selectionFailure(
  c: Parameters<typeof failureResponse>[0],
  error: PersonalDedicatedSelectionError,
) {
  const notFound = error.code === "PERSONAL_DEDICATED_SELECTION_NOT_FOUND";
  return c.json(
    {
      success: false,
      code: notFound
        ? "personal_dedicated_selection_not_found"
        : "personal_dedicated_selection_conflict",
      error: notFound
        ? "Eligible Dedicated inventory not found"
        : "The Dedicated inventory is not safe to select. Refresh the preview before retrying.",
    },
    notFound ? 404 : 409,
  );
}

export function createAdminPersonalDedicatedSelectionRoute(
  dependencies: AdminPersonalDedicatedSelectionRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    try {
      const { user, role } = await dependencies.requireAdmin(c);
      if (role !== "super_admin") {
        return c.json(
          { success: false, error: "Super admin access required" },
          403,
        );
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { success: false, error: "Request body must be valid JSON" },
          400,
        );
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { success: false, error: "Invalid Dedicated selection request" },
          400,
        );
      }

      const input = parsed.data;
      const sourceAgentId = personalSharedAgentId({
        organizationId: input.targetOwnerOrganizationId,
        userId: input.targetOwnerUserId,
      });
      const common = {
        organizationId: input.targetOwnerOrganizationId,
        userId: input.targetOwnerUserId,
        sourceAgentId,
        retainedAgentId: input.retainedAgentId,
        selectedByUserId: user.id,
        reason: input.reason,
      };
      const result = input.dryRun
        ? await dependencies.selectionService.preview(common)
        : await dependencies.selectionService.execute({
            ...common,
            expectedInventoryFingerprint: input.inventoryFingerprint,
            expectedStateDisposition: input.stateDisposition,
          });

      dependencies.logger.info(
        "[admin-personal-dedicated-selection] Selection decision accepted",
        {
          actorUserId: user.id,
          ownerOrganizationId: input.targetOwnerOrganizationId,
          ownerUserId: input.targetOwnerUserId,
          retainedAgentId: result.retainedAgentId,
          dryRun: input.dryRun,
          alreadySelected: result.alreadySelected,
          candidateCount: result.candidateCount,
        },
      );

      return c.json({
        success: true,
        dryRun: input.dryRun,
        data: result,
      });
    } catch (error) {
      // error-policy:J1 typed inventory conflicts are deliberately
      // non-oracular; every other failure uses the canonical API envelope.
      if (error instanceof PersonalDedicatedSelectionError) {
        return selectionFailure(c, error);
      }
      return failureResponse(c, error);
    }
  });

  return app;
}

export default createAdminPersonalDedicatedSelectionRoute();
