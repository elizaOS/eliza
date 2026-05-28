type SupportedEnvKey =
  | "EMAIL_FROM"
  | "NOTIFICATION_EMAIL_FROM";

export function getTrimmedEnv(name: SupportedEnvKey): string | undefined {
  // Intentionally avoid dynamic environment lookups so `env:audit` can keep
  // tracking repo-owned env keys precisely.
  const rawValue =
    name === "EMAIL_FROM"
      ? process.env.EMAIL_FROM
      : process.env.NOTIFICATION_EMAIL_FROM;

  const trimmed = rawValue?.trim();
  return trimmed ? trimmed : undefined;
}

export function getNotificationEmailFromEnv(): string | undefined {
  // Canonical: NOTIFICATION_EMAIL_FROM. Legacy alias: EMAIL_FROM.
  return (
    getTrimmedEnv("NOTIFICATION_EMAIL_FROM") ?? getTrimmedEnv("EMAIL_FROM")
  );
}
