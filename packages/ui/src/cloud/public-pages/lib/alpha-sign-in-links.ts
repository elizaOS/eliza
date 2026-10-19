import { sanitizeLoginReturnTo } from "./login-return-to";

/** Fixed Alpha navigation carries only the existing validated login continuation. */
export function alphaSignInLinks(searchParams: {
  get(name: string): string | null;
}) {
  const returnTo = sanitizeLoginReturnTo(searchParams.get("returnTo"));
  const query = returnTo ? `?${new URLSearchParams({ returnTo })}` : "";
  return {
    login: `/alpha/sign-in${query}`,
    terms: `/alpha/terms-of-service${query}`,
    privacy: `/alpha/privacy-policy${query}`,
  };
}
