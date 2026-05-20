// GET /api/admin/permissions - Current user's admin permissions

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import { ADMIN_PERMISSIONS, ROLE_PERMISSIONS } from '@babylon/db';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  // Note: hasPermission is computed client-side from the permissions array
  // Functions cannot be serialized in JSON responses
  return successResponse({
    userId: admin.userId,
    role: admin.role,
    permissions: admin.permissions,
    allPermissions: [...ADMIN_PERMISSIONS],
    rolePermissions: ROLE_PERMISSIONS,
  });
});
