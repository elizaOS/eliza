/** Pure validation shared by the host and renderer; never follows or rewrites a link. */
export function gmailSourceLink(value, threadId, accountEmail) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    typeof threadId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(threadId)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.host !== "mail.google.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash !== `#all/${threadId}`
    )
      return null;
    const match = /^\/mail\/u\/([^/]+)\/$/.exec(url.pathname);
    if (!match) return null;
    const account = decodeURIComponent(match[1]);
    if (
      !/^[^\s<>@/]+@[^\s<>@/]+\.[^\s<>@/]+$/.test(account) ||
      account.length > 320
    )
      return null;
    if (
      accountEmail !== undefined &&
      (typeof accountEmail !== "string" ||
        account.toLowerCase() !== accountEmail.toLowerCase())
    )
      return null;
    // Reject URL normalization tricks instead of silently repairing provider data.
    if (url.href !== value) return null;
    return value;
  } catch {
    return null;
  }
}
