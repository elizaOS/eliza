"use client";

import { useParams } from "next/navigation";
import { ProfilePageClient } from "@/components/profile/ProfilePageClient";

export function MobileUserProfileByIdPage() {
  const params = useParams();
  const identifier = decodeURIComponent(params.userId as string);
  return <ProfilePageClient identifier={identifier} mode="user_id" />;
}
