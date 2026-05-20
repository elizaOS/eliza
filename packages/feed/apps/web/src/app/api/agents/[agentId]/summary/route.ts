import { authenticateUser, withErrorHandling } from '@feed/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAgentSidebarSummary } from '@/lib/agents/agent-sidebar-summary';

export const GET = withErrorHandling(async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const user = await authenticateUser(req);
  const { agentId } = await params;

  const summary = await getAgentSidebarSummary({
    ownerId: user.id,
    agentId,
  });

  return NextResponse.json({
    success: true,
    ...summary,
  });
});
