/**
 * OAuth Authentication
 * 
 * Handles the OAuth authentication flow, including token retrieval,
 * refresh, and authorization redirects.
 */

import { AuthMethod, AuthState, AuthResult, AuthToken, OAuthConfig } from './types.js';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';
import { createDeferred } from '../utils/async.js';
import open from 'open';

/**
 * Default OAuth configuration for Anthropic API
 */
export const DEFAULT_OAUTH_CONFIG: OAuthConfig = {
  clientId: 'claude-code-cli',
  authorizationEndpoint: 'https://auth.anthropic.com/oauth2/auth',
  tokenEndpoint: 'https://auth.anthropic.com/oauth2/token',
  redirectUri: 'http://localhost:3000/callback',
  scopes: ['anthropic.claude'],
  responseType: 'code',
  usePkce: true
};

/**
 * Performs the OAuth authentication flow
 */
export async function performOAuthFlow(config: OAuthConfig): Promise<AuthResult> {
  logger.info('Starting OAuth authentication flow');
  
  try {
    // Generate code verifier and challenge if using PKCE
    const { codeVerifier, codeChallenge } = config.usePkce 
      ? generatePkceParams() 
      : { codeVerifier: '', codeChallenge: '' };
    
    // Generate a random state
    const state = generateRandomString(32);
    
    // Build the authorization URL
    const authUrl = buildAuthorizationUrl(config, state, codeChallenge);
    
    // Open the browser to the authorization URL
    logger.debug(`Opening browser to: ${authUrl}`);
    await open(authUrl);
    
    // Start a local server to listen for the callback
    logger.debug('Starting local server to receive callback');
    const { code, receivedState } = await startLocalServerForCallback(config.redirectUri);
    
    // Verify state matches
    if (state !== receivedState) {
      throw createUserError('OAuth state mismatch. Authentication may have been tampered with', {
        category: ErrorCategory.AUTHENTICATION,
        resolution: 'Try the authentication process again. If the issue persists, contact support.'
      });
    }
    
    // Exchange code for token
    logger.debug('Exchanging code for token');
    const token = await exchangeCodeForToken(config, code, codeVerifier);
    
    logger.info('OAuth authentication successful');
    
    return {
      success: true,
      method: AuthMethod.OAUTH,
      token,
      state: AuthState.AUTHENTICATED
    };
  } catch (error) {
    logger.error('OAuth authentication failed', error);
    
    return {
      success: false,
      method: AuthMethod.OAUTH,
      error: error instanceof Error ? error.message : String(error),
      state: AuthState.FAILED
    };
  }
}

/**
 * Refresh an OAuth token
 */
export async function refreshOAuthToken(refreshToken: string, config: OAuthConfig): Promise<AuthToken> {
  logger.debug('Refreshing OAuth token');
  
  try {
    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }).toString()
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw createUserError(`Failed to refresh token: ${error}`, {
        category: ErrorCategory.AUTHENTICATION,
        resolution: 'Try logging in again. Your session may have expired.'
      });
    }
    
    const data = await response.json();
    
    // Build token from response
    const token: AuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Use existing refresh token if not provided
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || ''
    };
    
    logger.debug('Token refreshed successfully');
    
    return token;
  } catch (error) {
    logger.error('Failed to refresh token', error);
    throw createUserError('Failed to refresh authentication token', {
      cause: error,
      category: ErrorCategory.AUTHENTICATION,
      resolution: 'Try logging in again with the --login flag.'
    });
  }
}

/**
 * Generate PKCE parameters (code verifier and challenge)
 */
function generatePkceParams(): { codeVerifier: string; codeChallenge: string } {
  // In a real implementation, this would use crypto functions to generate
  // a proper code verifier and S256 code challenge.
  // For simplicity, we're using a placeholder implementation.
  
  const codeVerifier = generateRandomString(64);
  
  // In a real implementation, this would be a SHA256 hash of the verifier
  // For now, we'll just use the same string (this is not secure!)
  const codeChallenge = codeVerifier;
  
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a random string of the specified length
 */
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}

/**
 * Build the authorization URL
 */
function buildAuthorizationUrl(
  config: OAuthConfig,
  state: string,
  codeChallenge: string
): string {
  const url = new URL(config.authorizationEndpoint);
  
  // Add query parameters
  url.searchParams.append('client_id', config.clientId);
  url.searchParams.append('redirect_uri', config.redirectUri);
  url.searchParams.append('response_type', config.responseType);
  url.searchParams.append('state', state);
  
  // Add scopes
  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.append('scope', config.scopes.join(' '));
  }
  
  // Add PKCE challenge if available
  if (codeChallenge) {
    url.searchParams.append('code_challenge', codeChallenge);
    url.searchParams.append('code_challenge_method', 'S256');
  }
  
  return url.toString();
}

/**
 * Start a local server to listen for the OAuth callback
 */
async function startLocalServerForCallback(redirectUri: string): Promise<{ code: string; receivedState: string }> {
  // In a real implementation, this would start a local HTTP server
  // listening on the redirect URI and wait for the callback.
  // For simplicity, we're simulating this behavior.
  
  const { promise, resolve } = createDeferred<{ code: string; receivedState: string }>();
  
  // Extract port from redirect URI
  const url = new URL(redirectUri);
  const port = parseInt(url.port, 10) || 80;
  
  logger.debug(`Would start local server on port ${port}`);
  
  // Simulate receiving a callback after some time
  setTimeout(() => {
    // In a real implementation, this would parse the callback URL
    // For now, we're just simulating a successful response
    resolve({
      code: generateRandomString(32),
      receivedState: generateRandomString(32)
    });
  }, 1000);
  
  return promise;
}

/**
 * Exchange authorization code for token
 */
async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  codeVerifier: string
): Promise<AuthToken> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri
  });
  
  // Add code verifier if using PKCE
  if (codeVerifier) {
    params.append('code_verifier', codeVerifier);
  }
  
  // Make the token request
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: params.toString()
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw createUserError(`Failed to exchange code for token: ${error}`, {
      category: ErrorCategory.AUTHENTICATION
    });
  }
  
  const data = await response.json();
  
  // Build token from response
  const token: AuthToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    tokenType: data.token_type || 'Bearer',
    scope: data.scope || ''
  };
  
  return token;
} 