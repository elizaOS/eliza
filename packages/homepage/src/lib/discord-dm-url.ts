/** Builds the public Discord profile/DM URL for the configured Eliza bot. */
export function buildDiscordDmUrl(
  applicationId = import.meta.env.VITE_DISCORD_CLIENT_ID,
): string | null {
  const normalized = applicationId?.trim();
  if (!normalized || !/^\d{17,20}$/.test(normalized)) return null;
  return `https://discord.com/users/${normalized}`;
}
