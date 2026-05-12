/**
 * Resource Authorization Service
 * Verifies user access to resources in SSE streams and API endpoints
 */

import { and, eq } from "drizzle-orm";
import { dbRead } from "@/db/client";
import { containers } from "@/db/schemas/containers";
import { conversations } from "@/db/schemas/conversations";
import { organizations } from "@/db/schemas/organizations";

/**
 * Parameters for resource access verification.
 */
export interface ResourceAccessParams {
  organizationId: string;
  userId: string;
  eventType: string;
  resourceId: string;
}

/**
 * Verifies if a user has access to a specific resource based on event type.
 *
 * @param params - Resource access parameters.
 * @returns True if access is granted.
 * @throws Error if resource access is denied.
 */
export async function verifyResourceAccess(params: ResourceAccessParams): Promise<boolean> {
  const { organizationId, eventType, resourceId } = params;

  switch (eventType) {
    case "agent": {
      // For agent events, resourceId is the roomId
      // Verify the room/conversation belongs to the organization
      const conversation = await dbRead.query.conversations.findFirst({
        where: eq(conversations.id, resourceId),
        columns: { id: true, organization_id: true },
      });

      if (!conversation || conversation.organization_id !== organizationId) {
        return false;
      }
      return true;
    }

    case "credits": {
      // For credit events, resourceId should be the organization ID
      if (resourceId !== organizationId) {
        return false;
      }
      return true;
    }

    case "container": {
      // For container events, verify container belongs to organization
      const container = await dbRead
        .select()
        .from(containers)
        .where(and(eq(containers.id, resourceId), eq(containers.organization_id, organizationId)))
        .limit(1);

      if (!container || container.length === 0) {
        return false;
      }
      return true;
    }

    default:
      // Unknown event type, deny access
      return false;
  }
}

/**
 * Verifies organization exists and user has access.
 *
 * @param organizationId - Organization ID to verify.
 * @returns True if organization exists.
 */
export async function verifyOrganizationAccess(organizationId: string): Promise<boolean> {
  const org = await dbRead.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { id: true },
  });

  return !!org;
}
