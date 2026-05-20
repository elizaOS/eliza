/**
 * Page: /share/referral/[userId]
 * Shareable referral page with OG meta tags
 */

import { getOrCreateReferralCode } from '@babylon/api';
import { db } from '@babylon/db';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

// Use Node.js runtime for database access
export const runtime = 'nodejs';

interface PageProps {
  params: Promise<{
    userId: string;
  }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { userId: rawUserId } = await params;
  // Decode URL-encoded userId (colons in Privy DIDs are encoded as %3A)
  const userId = decodeURIComponent(rawUserId);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://babylon.market';
  const ogImageUrl = `${appUrl}/api/og/referral/${encodeURIComponent(userId)}`;

  // Get user data
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      displayName: true,
    },
  });

  if (!user) {
    // User not found - return default metadata
    return {
      title: 'Join Babylon',
      description: 'Trade narratives, share the upside',
    };
  }

  // Generate referral code if it doesn't exist (ensures OG metadata always has ref param)
  const referralCode = await getOrCreateReferralCode(userId);

  const displayName = user.displayName || user.username || 'A Babylon Trader';
  const referralLink = `${appUrl}/?ref=${referralCode}`;

  return {
    title: `${displayName} invited you to Babylon`,
    description: `Join ${displayName} on Babylon and start trading narratives. Earn rewards for signing up!`,
    openGraph: {
      title: `${displayName} invited you to Babylon`,
      description: 'Trade narratives, share the upside',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `Join ${displayName} on Babylon`,
        },
      ],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${displayName} invited you to Babylon`,
      description: 'Trade narratives, share the upside',
      images: [ogImageUrl],
    },
    other: {
      // Farcaster Frame meta tags
      'fc:frame': 'vNext',
      'fc:frame:image': ogImageUrl,
      'fc:frame:image:aspect_ratio': '1.91:1',
      'fc:frame:button:1': 'Join Babylon',
      'fc:frame:button:1:action': 'link',
      'fc:frame:button:1:target': referralLink,
    },
  };
}

export default async function ShareReferralPage({ params }: PageProps) {
  const { userId: rawUserId } = await params;
  // Decode URL-encoded userId (colons in Privy DIDs are encoded as %3A)
  const userId = decodeURIComponent(rawUserId);

  // Check if user exists
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    redirect('/');
  }

  // Get or create referral code for the user
  const referralCode = await getOrCreateReferralCode(userId);

  // Redirect to home with referral code
  redirect(`/?ref=${referralCode}`);
}
