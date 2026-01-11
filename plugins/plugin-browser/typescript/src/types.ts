/**
 * Browser Plugin Types
 * Defines all types used across the browser automation plugin
 */

// Session Types
export interface BrowserSession {
  id: string;
  createdAt: Date;
  url?: string;
  title?: string;
}

// Result Types
export interface NavigationResult {
  success: boolean;
  url: string;
  title: string;
  error?: string;
}

export interface BrowserActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ExtractResult {
  success: boolean;
  found: boolean;
  data?: string;
  error?: string;
}

export interface ScreenshotResult {
  success: boolean;
  data?: string;
  mimeType?: "image/png" | "image/jpeg";
  url?: string;
  title?: string;
  error?: string;
}

export interface CaptchaResult {
  detected: boolean;
  type: CaptchaType;
  siteKey?: string;
  solved: boolean;
  token?: string;
  error?: string;
}

export type CaptchaType = "turnstile" | "recaptcha-v2" | "recaptcha-v3" | "hcaptcha" | "none";

// Configuration Types
export interface SecurityConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUrlLength?: number;
  allowLocalhost?: boolean;
  allowFileProtocol?: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface BrowserConfig {
  headless?: boolean;
  browserbaseApiKey?: string;
  browserbaseProjectId?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  capsolverApiKey?: string;
  serverPort?: number;
}

// WebSocket Protocol Types
export interface WebSocketMessage {
  type: string;
  requestId: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface WebSocketResponse {
  type: string;
  requestId: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// CapSolver Types
export interface CapSolverConfig {
  apiKey: string;
  apiUrl?: string;
  retryAttempts?: number;
  pollingInterval?: number;
}

export interface CaptchaTask {
  type: string;
  websiteURL: string;
  websiteKey: string;
  proxy?: string;
  userAgent?: string;
  [key: string]: string | boolean | number | undefined;
}

// Rate Limiting Types
export interface RateLimitConfig {
  maxActionsPerMinute: number;
  maxSessionsPerHour: number;
}

export interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// Browser Service Type (matches core's ServiceType.BROWSER)
export const BROWSER_SERVICE_TYPE = "browser" as const;
