import { ProfilePageClient } from "@/components/profile/ProfilePageClient";

export default async function UserProfileByHandlePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const identifier = decodeURIComponent(handle);
  return <ProfilePageClient identifier={identifier} mode="user" />;
}
