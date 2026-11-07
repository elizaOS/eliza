/** Only call with a return URL verified from server-owned OAuth state. */
export function buildOAuthAppErrorReturn(
  redirectUrl: string,
  state: string,
  code: string,
  allowedReturns?: string,
): string | null {
  if (
    !allowedReturns
      ?.split(",")
      .map((value) => value.trim())
      .includes(redirectUrl)
  )
    return null;
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !state ||
    state.length > 1024 ||
    !/^[a-z0-9_]{1,100}$/.test(code)
  )
    return null;
  // Use the same fragment transport as successful code callbacks. Do not echo
  // provider descriptions, credentials, or pre-existing callback parameters.
  url.search = "";
  url.hash = new URLSearchParams({ error: code, state }).toString();
  return url.toString();
}
