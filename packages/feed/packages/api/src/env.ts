type SupportedEnvKey =
  | 'EMAIL_FROM'
  | 'NEXT_PUBLIC_PRIVY_APP_ID'
  | 'NOTIFICATION_EMAIL_FROM'
  | 'PRIVY_APP_ID'
  | 'PRIVY_APP_SECRET'
  | 'PRIVY_AUTHORIZATION_PRIVATE_KEY'
  | 'PRIVY_OFFLINE_POLICY_ID'
  | 'PRIVY_SOLANA_OFFLINE_POLICY_ID'
  | 'PRIVY_OFFLINE_SIGNER_ID';

export function getTrimmedEnv(name: SupportedEnvKey): string | undefined {
  // Intentionally avoid dynamic environment lookups so `env:audit` can keep
  // tracking repo-owned env keys precisely.
  const rawValue =
    name === 'EMAIL_FROM'
      ? process.env.EMAIL_FROM
      : name === 'NEXT_PUBLIC_PRIVY_APP_ID'
        ? process.env.NEXT_PUBLIC_PRIVY_APP_ID
        : name === 'NOTIFICATION_EMAIL_FROM'
          ? process.env.NOTIFICATION_EMAIL_FROM
          : name === 'PRIVY_APP_ID'
            ? process.env.PRIVY_APP_ID
            : name === 'PRIVY_APP_SECRET'
              ? process.env.PRIVY_APP_SECRET
              : name === 'PRIVY_AUTHORIZATION_PRIVATE_KEY'
                ? process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
                : name === 'PRIVY_OFFLINE_POLICY_ID'
                  ? process.env.PRIVY_OFFLINE_POLICY_ID
                  : name === 'PRIVY_SOLANA_OFFLINE_POLICY_ID'
                    ? process.env.PRIVY_SOLANA_OFFLINE_POLICY_ID
                    : process.env.PRIVY_OFFLINE_SIGNER_ID;

  const trimmed = rawValue?.trim();
  return trimmed ? trimmed : undefined;
}

export function getPrivyAppIdFromEnv(): string | undefined {
  // Prefer the server-scoped key, but allow the public key as a legacy alias.
  return (
    getTrimmedEnv('PRIVY_APP_ID') ?? getTrimmedEnv('NEXT_PUBLIC_PRIVY_APP_ID')
  );
}

export function getNotificationEmailFromEnv(): string | undefined {
  // Canonical: NOTIFICATION_EMAIL_FROM. Legacy alias: EMAIL_FROM.
  return (
    getTrimmedEnv('NOTIFICATION_EMAIL_FROM') ?? getTrimmedEnv('EMAIL_FROM')
  );
}
