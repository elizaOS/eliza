import { authenticateUser, withErrorHandling } from '@feed/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getTeamDashboardData } from '@/lib/agents/team-dashboard';

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  const user = await authenticateUser(req);

  const dashboard = await getTeamDashboardData({
    ownerId: user.id,
    ownerName: 'You',
  });

  return NextResponse.json({
    success: true,
    agents: dashboard.agents,
    summary: dashboard.summary,
  });
});
