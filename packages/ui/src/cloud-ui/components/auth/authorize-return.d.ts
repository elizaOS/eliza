export declare const APP_AUTHORIZE_PATH = "/app-auth/authorize";
export declare const APP_AUTH_RETURN_TO_KEY = "eliza_app_auth_return_to";
export declare function buildAppAuthorizeReturnTo(search: string): string;
export declare function buildAppAuthorizeLoginHref(search: string): string;
export declare function buildAppAuthorizeCompletionRedirect(input: {
  code: string;
  redirectUri: string;
  state?: string | null;
}): string;
export declare function buildAppAuthorizeCancelRedirect(input: {
  redirectUri: string;
  state?: string | null;
}): string;
export declare function storeCurrentAppAuthorizeReturnTo(): void;
export declare function clearStoredAppAuthorizeReturnTo(): void;
export declare function readStoredAppAuthorizeReturnTo(): string | null;
//# sourceMappingURL=authorize-return.d.ts.map
