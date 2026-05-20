"use client";

import { useParams } from "next/navigation";
import { ProfilePageClient } from "@/components/profile/ProfilePageClient";

export function MobileUserProfileByHandlePage() {
  const params = useParams();
  const identifier = decodeURIComponent(params.handle as string);
  return <ProfilePageClient identifier={identifier} mode="user" />;
}
