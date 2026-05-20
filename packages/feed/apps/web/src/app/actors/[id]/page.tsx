import { ProfilePageClient } from '@/components/profile/ProfilePageClient';

export default async function ActorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const identifier = decodeURIComponent(id);
  return <ProfilePageClient identifier={identifier} mode="actor" />;
}
