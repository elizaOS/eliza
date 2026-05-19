import {
  GOOGLE_CAPABILITIES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleCapability,
  normalizeGoogleCapabilities,
  scopesForGoogleCapabilities,
} from "./scopes.js";
import {
  GOOGLE_SERVICE_NAME,
  type GoogleAuthResolutionRequest,
  type GoogleCredentialResolver,
  type GoogleOAuthProviderConfig,
  type GoogleOAuthProviderMetadata,
} from "./types.js";

export const GOOGLE_OAUTH_PROVIDER_METADATA: GoogleOAuthProviderMetadata = {
  provider: GOOGLE_SERVICE_NAME,
  label: "Google Workspace",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  clientIdSetting: "GOOGLE_CLIENT_ID",
  clientSecretSetting: "GOOGLE_CLIENT_SECRET",
  redirectUriSetting: "GOOGLE_REDIRECT_URI",
  responseType: "code",
  accessType: "offline",
  prompt: "consent",
  supportsPkce: true,
  identityScopes: GOOGLE_IDENTITY_SCOPES,
  capabilities: GOOGLE_CAPABILITIES,
};

export function getGoogleOAuthProviderMetadata(): GoogleOAuthProviderMetadata {
  return GOOGLE_OAUTH_PROVIDER_METADATA;
}

export function getGoogleOAuthProviderConfig(
  capabilities: readonly GoogleCapability[]
): GoogleOAuthProviderConfig {
  const normalized = normalizeGoogleCapabilities(capabilities);

  return {
    provider: GOOGLE_SERVICE_NAME,
    authUrl: GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint,
    tokenUrl: GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint,
    capabilities: normalized,
    scopes: scopesForGoogleCapabilities(normalized),
    authorizationParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
  };
}

export class MissingGoogleCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(request: GoogleAuthResolutionRequest): Promise<never> {
    throw new Error(
      `Google auth client for account ${request.accountId} is not available. ` +
        `Requested capabilities: ${request.capabilities.join(", ") || "identity"}; ` +
        `scopes: ${request.scopes.join(" ") || "none"}. ` +
        "Inject a GoogleCredentialResolver backed by the shared connector account OAuth store."
    );
  }
}
