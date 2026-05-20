/**
 * Agent Detail Page - Redirects to Team Chat
 *
 * @description This page now redirects to the team chat page.
 * All agent management is done through the team chat interface.
 *
 * @page /agents/[agentId]
 * @redirect /agents/team?selectAgent=[agentId]
 */

'use client';

export const dynamic = 'force-dynamic';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Agent Detail Page Component
 *
 * Redirects to team chat page with the agent selected.
 */
export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;

  useEffect(() => {
    // Redirect to team chat with the agent selected
    router.replace(`/agents/team?selectAgent=${encodeURIComponent(agentId)}`);
  }, [agentId, router]);

  // Show nothing while redirecting
  return null;
}
