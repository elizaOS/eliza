import { ProfilePageClient } from "@/components/profile/ProfilePageClient";

export default async function UserProfileByIdPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const identifier = decodeURIComponent(userId);
  return <ProfilePageClient identifier={identifier} mode="user_id" />;
}
