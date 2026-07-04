/**
 * Payload shape submitted when a new player completes the onboarding profile step —
 * carries identity fields, optional imported social accounts, and legal acceptance flags.
 */
export interface OnboardingProfilePayload {
  username: string;
  displayName?: string;
  email?: string;
  bio?: string;
  profileImageUrl?: string | null;
  coverImageUrl?: string | null;
  // Social account import data (from onboarding social import)
  importedFrom?: "twitter" | "farcaster" | null;
  twitterId?: string | null;
  twitterUsername?: string | null;
  farcasterFid?: string | null;
  farcasterUsername?: string | null;
  // Legal acceptance (required for GDPR compliance)
  tosAccepted?: boolean;
  privacyPolicyAccepted?: boolean;
}
