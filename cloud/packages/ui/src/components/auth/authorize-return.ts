const APP_AUTHORIZE_PATH = "/app-auth/authorize";

export function buildAppAuthorizeReturnTo(search: string): string {
  const normalizedSearch = search && search.startsWith("?") ? search : search ? `?${search}` : "";
  return `${APP_AUTHORIZE_PATH}${normalizedSearch}`;
}

export function buildAppAuthorizeLoginHref(search: string): string {
  return `/login?returnTo=${encodeURIComponent(buildAppAuthorizeReturnTo(search))}`;
}
