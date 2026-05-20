'use client';

import { useParams } from 'next/navigation';
import { ProfilePageClient } from '@/components/profile/ProfilePageClient';

export function MobileOrgProfilePage() {
  const params = useParams();
  const identifier = decodeURIComponent(params.id as string);
  return <ProfilePageClient identifier={identifier} mode="org" />;
}
