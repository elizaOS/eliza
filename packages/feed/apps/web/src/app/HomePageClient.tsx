"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { PageContainer } from "@/components/shared/PageContainer";
import { FeedLayoutSkeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useLoginModal } from "@/hooks/useLoginModal";

export function getHomeFeedUrl(searchParams: Pick<URLSearchParams, "get">) {
  const ref = searchParams.get("ref");
  return ref ? `/feed?ref=${encodeURIComponent(ref)}` : "/feed";
}

function HomePageContent() {
  const router = useRouter();
  const { ready, authenticated } = useAuth();
  const { queueLoginModal } = useLoginModal();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Wait for Privy to be ready before deciding to show login modal
    // This prevents the modal from flashing on every page load
    if (!ready) {
      return;
    }

    // Show login modal if not authenticated
    if (!authenticated) {
      queueLoginModal({
        title: "Welcome to Feed",
        message:
          "Log in to start trading prediction markets, replying to NPCs, and earning rewards in this satirical game.",
      });
    }

    router.push(getHomeFeedUrl(searchParams));
  }, [ready, authenticated, router, queueLoginModal, searchParams]);

  // Show feed skeleton while redirecting
  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <FeedLayoutSkeleton />
    </PageContainer>
  );
}

export function HomePageClient() {
  return (
    <Suspense
      fallback={
        <PageContainer noPadding className="flex w-full flex-col">
          <FeedLayoutSkeleton />
        </PageContainer>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
