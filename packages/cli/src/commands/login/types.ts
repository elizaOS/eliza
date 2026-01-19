export interface LoginOptions {
  cloudUrl: string;
  browser: boolean;
  timeout: string;
  /** Optional path to the .env file where the API key should be written */
  envFilePath?: string;
}

export interface LoginSession {
  sessionId: string;
  authUrl: string;
  expiresAt: number;
}

export interface LoginResponse {
  apiKey: string;
  keyPrefix: string;
  expiresAt: string | null;
}

export interface SessionStatusResponse {
  status: 'pending' | 'authenticated' | 'expired';
  apiKey?: string;
  keyPrefix?: string;
  expiresAt?: string | null;
}
