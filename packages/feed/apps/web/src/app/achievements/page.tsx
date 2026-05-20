"use client";

export const dynamic = "force-dynamic";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AchievementsTab } from "@/components/rewards/v2/achievements-tab";
import { PageContainer } from "@/components/shared/PageContainer";
import { useAuth } from "@/hooks/useAuth";

export default function AchievementsPage() {
  const router = useRouter();
  const { ready, authenticated, login } = useAuth();

  useEffect(() => {
    if (!ready || authenticated) return;
    router.push("/feed");
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [ready, authenticated, router, login]);

  return (
    <PageContainer
      noPadding
      className="overflow-x-clip! flex flex-col pt-14 md:pt-0"
    >
      <div className="min-h-full w-full border-border lg:border-r lg:border-l">
        <div className="sticky top-14 z-10 border-border border-b bg-background/95 px-4 py-3 backdrop-blur-sm md:top-0">
          <h1 className="font-semibold text-foreground text-lg">
            Achievements
          </h1>
        </div>
        <div className="p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:pb-4">
          <AchievementsTab />
        </div>
      </div>
    </PageContainer>
  );
}
