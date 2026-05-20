"use client";

export const dynamic = "force-dynamic";

import { extractUsername } from "@feed/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PageContainer } from "@/components/shared/PageContainer";
import { ProfileHeaderSkeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";

/**
 * Legacy profile route.
 *
 * We keep `/profile` as a stable entry point (Sidebar, old links) and redirect
 * to the canonical user route.
 *
 * This route exists as a stable "My Profile" entry point (Sidebar, etc.) and
 * redirects to the username- or id-based profile page to avoid UI drift between
 * `/profile` and `/profile/[id]`.
 */
export default function ProfileRootRedirectPage() {
  const router = useRouter();
  const { ready, authenticated, user, login } = useAuth();

  useEffect(() => {
    if (!ready) return;

    if (!authenticated || !user?.id) {
      router.replace("/feed");
      // Match previous behavior: trigger login shortly after redirecting.
      const timer = window.setTimeout(() => login(), 500);
      return () => window.clearTimeout(timer);
    }

    const identifier = user.username ? extractUsername(user.username) : user.id;

    if (user.username) {
      router.replace(`/u/${encodeURIComponent(identifier)}`);
      return undefined;
    }

    router.replace(`/u/id/${encodeURIComponent(identifier)}`);
    return undefined;
  }, [ready, authenticated, user?.id, user?.username, router, login]);

  return (
    <PageContainer noPadding className="min-h-dvh md:min-h-screen">
      <div className="mx-auto w-full max-w-[700px]">
        <ProfileHeaderSkeleton />
      </div>
    </PageContainer>
  );
}
