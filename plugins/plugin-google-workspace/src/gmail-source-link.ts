/** Link to a known Gmail thread in the resolved account, never a numeric default mailbox. */
export function gmailThreadSourceLink(
  threadId: string,
  accountEmail: string | null
): string | null {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(threadId)) return null;
  const email = accountEmail?.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) return null;
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#all/${threadId}`;
}
