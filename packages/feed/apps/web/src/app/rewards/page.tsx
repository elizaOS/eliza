"use client";

export const dynamic = "force-dynamic";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AchievementsTab } from "@/components/rewards/v2/achievements-tab";
import { ChallengesTab } from "@/components/rewards/v2/challenges-tab";
import { OverviewTab } from "@/components/rewards/v2/overview-tab";
import { TabNavigation } from "@/components/rewards/v2/tab-navigation";
import { PageContainer } from "@/components/shared/PageContainer";
import { useAuth } from "@/hooks/useAuth";

type Tab = "overview" | "achievements" | "challenges";

export default function RewardsPage() {
  const router = useRouter();
  const { ready, authenticated, login, refresh } = useAuth();

  // Auth required — redirect to feed and show login
  useEffect(() => {
    if (!ready || authenticated) return;
    router.push("/feed");
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [ready, authenticated, router, login]);

  const searchParams = useSearchParams();

  // Handle OAuth callback from Twitter/Discord linking
  useEffect(() => {
    const success = searchParams.get("success");
    const reputation = searchParams.get("reputation");
    const errorParam = searchParams.get("error");

    if (success === "twitter_linked" && reputation) {
      toast.success(`X account linked! +${reputation} reputation awarded`);
      window.dispatchEvent(new CustomEvent("rewards-updated"));
      refresh();
      window.history.replaceState({}, "", "/rewards");
    } else if (success === "discord_linked" && reputation) {
      toast.success(
        `Discord account linked! +${reputation} reputation awarded`,
      );
      window.dispatchEvent(new CustomEvent("rewards-updated"));
      refresh();
      window.history.replaceState({}, "", "/rewards");
    } else if (errorParam) {
      const errorMessages: Record<string, string> = {
        twitter_already_linked:
          "This X account is already linked to another user",
        discord_already_linked:
          "This Discord account is already linked to another user",
        token_exchange_failed: "Failed to authenticate. Please try again.",
        invalid_state: "Session expired. Please try again.",
        state_expired: "Session expired. Please try again.",
      };
      toast.error(
        errorMessages[errorParam] || "An error occurred. Please try again.",
      );
      window.history.replaceState({}, "", "/rewards");
    }
  }, [searchParams, refresh]);

  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const handleViewAchievements = () => {
    setActiveTab("achievements");
  };

  const handleViewChallenges = () => {
    setActiveTab("challenges");
  };

  return (
    <PageContainer
      noPadding
      className="overflow-x-clip! flex flex-col pt-14 md:pt-0"
    >
      <div className="min-h-full w-full border-border lg:border-r lg:border-l">
        <div className="sticky top-14 z-10 bg-background/95 backdrop-blur-sm md:top-0">
          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        <div className="p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:pb-4">
          {activeTab === "overview" && (
            <OverviewTab
              onViewAchievements={handleViewAchievements}
              onViewChallenges={handleViewChallenges}
            />
          )}
          {activeTab === "achievements" && <AchievementsTab />}
          {activeTab === "challenges" && <ChallengesTab />}
        </div>
      </div>
    </PageContainer>
  );
}
