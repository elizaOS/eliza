"use client";

export const dynamic = "force-dynamic";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AgentCreate } from "@/components/agents/AgentCreate";
import { PageContainer } from "@/components/shared/PageContainer";
import { useAuth } from "@/hooks/useAuth";

export default function CreateAgentPage() {
  const router = useRouter();
  const { ready, authenticated, login } = useAuth();

  // Auth required — redirect to feed and show login
  useEffect(() => {
    if (!ready || authenticated) return;
    router.push("/feed");
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [ready, authenticated, router, login]);

  if (!ready || !authenticated) {
    return null;
  }

  return (
    <PageContainer noPadding>
      <AgentCreate
        onBack={() => router.push("/agents")}
        onSuccess={(agent) => {
          // Redirect to team chat and select the new agent
          router.push(
            `/agents/team?selectAgent=${encodeURIComponent(agent.id)}`,
          );
        }}
      />
    </PageContainer>
  );
}
