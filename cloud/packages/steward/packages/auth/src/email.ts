import { randomBytes } from "node:crypto";

import { hashSha256Hex } from "./crypto";
import type { EmailProvider } from "./email-provider";
import { ConsoleProvider } from "./email-provider";
import {
  renderTemplate as defaultTemplateRenderer,
  type MagicLinkTemplateData,
  type RenderedMagicLinkTemplate,
} from "./email-templates";
import { TokenStore } from "./token-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailAuthConfig {
  /** Sender address, e.g. "login@steward.fi" */
  from: string;
  /** Base URL for building the callback link, e.g. "https://steward.fi" */
  baseUrl: string;
  /**
   * Pluggable email provider.
   * Defaults to ConsoleProvider so nothing breaks without API credentials.
   */
  provider?: EmailProvider;
  /** Token TTL in milliseconds. Default: 10 minutes. */
  tokenTtlMs?: number;
  /** Path that receives the magic-link callback. Default: "/auth/callback/email" */
  callbackPath?: string;
  /**
   * Optional external TokenStore to use for magic-link tokens.
   * Defaults to a fresh TokenStore backed by in-memory storage.
   * Pass a store configured with a Redis or Postgres backend for
   * restart-safe / multi-instance deployments.
   */
  tokenStore?: TokenStore;
  /** Override the magic-link template renderer. */
  templateRenderer?: (
    templateId: string | undefined,
    data: MagicLinkTemplateData,
  ) => RenderedMagicLinkTemplate;
  /** Template ID to render for outgoing magic-link emails. */
  templateId?: string;
  /** Override the rendered subject line. */
  subjectOverride?: string;
  /** Optional reply-to address to pass through to the provider. */
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CALLBACK = "/auth/callback/email";

function generateToken(): string {
  // URL-safe hex token (64 chars from 32 bytes)
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function hashToken(token: string): string {
  return hashSha256Hex(token);
}

function buildMagicLink(
  baseUrl: string,
  callbackPath: string,
  token: string,
  email: string,
): string {
  const url = new URL(callbackPath, baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("email", email);
  return url.toString();
}

// ---------------------------------------------------------------------------
// EmailAuth
// ---------------------------------------------------------------------------

export class EmailAuth {
  private provider: EmailProvider;
  private tokenStore: TokenStore;
  private baseUrl: string;
  private callbackPath: string;
  private tokenTtlMs: number;
  private from: string;
  private replyTo?: string;
  private templateId?: string;
  private subjectOverride?: string;
  private templateRenderer: (
    templateId: string | undefined,
    data: MagicLinkTemplateData,
  ) => RenderedMagicLinkTemplate;

  constructor(config: EmailAuthConfig) {
    this.from = config.from;
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.callbackPath = config.callbackPath ?? DEFAULT_CALLBACK;
    this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TTL_MS;
    this.provider = config.provider ?? new ConsoleProvider();
    this.tokenStore = config.tokenStore ?? new TokenStore();
    this.replyTo = config.replyTo;
    this.templateId = config.templateId;
    this.subjectOverride = config.subjectOverride;
    this.templateRenderer = config.templateRenderer ?? defaultTemplateRenderer;
  }

  /**
   * Generate a magic link token, persist its hash, and send the email.
   * Returns the token hash (for verification lookup) and the expiry date.
   */
  async sendMagicLink(email: string): Promise<{ tokenHash: string; expiresAt: Date }> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.tokenTtlMs);

    // Persist hash → email with TTL
    this.tokenStore.store(tokenHash, email, this.tokenTtlMs);

    // Build and send the email
    const magicLink = buildMagicLink(this.baseUrl, this.callbackPath, token, email);
    const rendered = this.templateRenderer(this.templateId, {
      magicLink,
      email,
      expiresInMinutes: Math.floor(this.tokenTtlMs / (60 * 1000)),
      tenantName: undefined,
    });
    const subject = this.subjectOverride || rendered.subject;
    const body = rendered.text;
    const html = rendered.html;

    await this.provider.send(email, subject, body, html, { replyTo: this.replyTo });

    return { tokenHash, expiresAt };
  }

  /**
   * Verify a raw token received from the callback URL.
   * One-time use: deletes the token after successful verification.
   */
  async verifyMagicLink(token: string): Promise<{ email: string; valid: boolean }> {
    const tokenHash = hashToken(token);
    const email = await this.tokenStore.verify(tokenHash);

    if (!email) {
      return { email: "", valid: false };
    }

    // Consume the token (one-time use)
    this.tokenStore.delete(tokenHash);

    return { email, valid: true };
  }

  /**
   * Clean up background timers.  Call in tests after each suite.
   */
  destroy(): void {
    this.tokenStore.destroy();
  }
}
