import { ProfilePageClient } from '@/components/profile/ProfilePageClient';

export default async function OrganizationProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const identifier = decodeURIComponent(id);
  return <ProfilePageClient identifier={identifier} mode="org" />;
}
