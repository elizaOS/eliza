/**
 * PostHog Analytics - Shared Types and Client-Side Tracking
 *
 * Event naming convention: snake_case with verb_noun format
 * e.g., agent_created, dashboard_viewed, signup_completed
 */

import posthog from "posthog-js";

export type PostHogEvent =
  // Authentication & Signup
  | "signup_completed"
  | "login_completed"
  | "logout_completed"
  // Navigation
  | "dashboard_viewed"
  | "page_viewed"
  // Agent Creation
  | "agent_create_started"
  | "agent_create_completed"
  | "agent_create_failed"
  | "agent_builder_opened"
  | "agent_builder_saved"
  // Agent Editing
  | "agent_edit_started"
  // Agent Engagement
  | "agent_chat_started"
  | "agent_chat_message_sent"
  | "agent_made_public"
  | "agent_deleted"
  // Container Deployment
  | "container_deploy_started"
  | "container_deploy_completed"
  | "container_deploy_failed"
  // Container Billing
  | "container_shutdown_insufficient_credits"
  | "container_shutdown_warning_sent"
  | "container_daily_billed"
  // Billing & Credits (Legacy - maintained for backwards compatibility)
  // Use these for basic credit tracking without payment method details
  | "credits_purchased" // Simple credit purchase event (use checkout_completed for detailed tracking)
  | "credits_purchase_started" // When user starts a credit pack purchase flow
  | "billing_page_viewed" // When billing page is viewed
  // Payment Events (Unified - preferred for new implementations)
  // These events include payment_method (stripe/crypto) and detailed metadata
  // Use checkout_completed instead of credits_purchased for comprehensive funnel analysis
  | "payment_method_selected" // User selects payment method (card/crypto)
  | "checkout_initiated" // Checkout session created (server-side only)
  | "checkout_completed" // Payment confirmed and credits added
  | "checkout_failed" // Payment failed
  // Crypto Payment Events
  | "crypto_payment_initiated"
  | "crypto_wallet_connected"
  | "crypto_payment_sent"
  | "crypto_payment_confirmed"
  | "crypto_payment_expired"
  // App Credits Events
  | "app_credits_checkout_initiated"
  | "app_credits_purchased"
  // Auto Top-Up Events
  | "auto_topup_triggered"
  | "auto_topup_completed"
  | "auto_topup_failed"
  // Checkout Funnel Events
  | "checkout_attempted"
  // Success/Invoice Events
  | "payment_success_viewed"
  | "invoice_viewed"
  // Feature Usage
  | "api_key_created"
  | "knowledge_uploaded"
  | "app_created";

export type AuthMethod = "email" | "google" | "discord" | "github" | "wallet";
export type AgentSource = "quick_create" | "builder" | "dashboard";

export interface PrivyUserAuthInfo {
  google?: { email?: string; name?: string } | null;
  discord?: { email?: string; username?: string } | null;
  github?: { username?: string } | null;
  wallet?: { address?: string } | null;
  email?: { address?: string } | null;
}

export function getSignupMethod(user: PrivyUserAuthInfo): AuthMethod {
  if (user.google) return "google";
  if (user.discord) return "discord";
  if (user.github) return "github";
  if (user.wallet && !user.email) return "wallet";
  return "email";
}

export interface SignupCompletedProps {
  method: AuthMethod;
  has_referral?: boolean;
  initial_credits?: number;
}

export interface AgentCreateStartedProps {
  source: AgentSource;
}

export interface AgentCreateCompletedProps {
  agent_id: string;
  agent_name: string;
  source: "quick_create" | "builder";
  has_custom_bio?: boolean;
  creation_time_ms?: number;
  agent_count?: number;
  is_first_agent?: boolean;
}

export interface AgentEditStartedProps {
  agent_id: string;
  agent_name?: string;
  source: "builder" | "chat" | "dashboard";
}

export interface AgentChatStartedProps {
  agent_id: string;
  agent_name?: string;
  is_first_chat: boolean;
}

export interface ContainerDeployProps {
  container_id?: string;
  container_name?: string;
  agent_id?: string;
  status?: "started" | "completed" | "failed";
  error_message?: string;
  deployment_time_ms?: number;
  is_update?: boolean;
  cpu?: number;
  memory?: number;
  container_url?: string;
  cost?: number;
}

export interface ContainerShutdownInsufficientCreditsProps {
  container_id: string;
  container_name: string;
  organization_id: string;
  balance_at_shutdown: number;
}

export interface ContainerShutdownWarningSentProps {
  container_id: string;
  container_name: string;
  organization_id: string;
  daily_cost: number;
  current_balance: number;
  scheduled_shutdown: string;
}

export interface ContainerDailyBilledProps {
  container_id: string;
  container_name: string;
  organization_id: string;
  amount: number;
  new_balance: number;
}

export interface PageViewedProps {
  page_name: string;
  page_path: string;
  referrer?: string;
}

export interface BillingPageViewedProps {
  current_credits: number;
  available_packs: number;
}

export interface CreditsPurchaseStartedProps {
  pack_id: string;
  pack_name?: string;
  credits?: number;
  price_cents?: number;
}

export interface CreditsPurchasedProps {
  amount: number;
  currency: string;
  purchase_type: string;
  organization_id: string;
  payment_method?: "stripe" | "crypto";
}

// Payment Method Types
export type PaymentMethod = "stripe" | "crypto";
export type PurchaseType =
  | "credit_pack"
  | "custom_amount"
  | "auto_top_up"
  | "app_credits";
export type PaymentSourcePage = "billing" | "settings" | "app";

// Payment Method Selection
export interface PaymentMethodSelectedProps {
  method: PaymentMethod;
  source_page: PaymentSourcePage;
  current_balance: number;
}

// Checkout Events
export interface CheckoutInitiatedProps {
  payment_method: PaymentMethod;
  amount: number;
  currency: string;
  organization_id: string;
  source_page: PaymentSourcePage;
  purchase_type: PurchaseType | string;
  credit_pack_id?: string;
  credit_pack_name?: string;
}

export interface CheckoutCompletedProps {
  payment_method: PaymentMethod;
  amount: number;
  currency: string;
  organization_id: string;
  purchase_type: PurchaseType | string;
  credits_added: number;
  stripe_session_id?: string;
  credit_pack_id?: string;
  credit_pack_name?: string;
  network?: string;
  token?: string;
  track_id?: string;
  validation_error?: boolean;
}

export interface CheckoutFailedProps {
  payment_method: PaymentMethod;
  amount?: number;
  currency?: string;
  organization_id: string;
  purchase_type?: string;
  error_reason: string;
  stripe_payment_intent_id?: string;
}

// Crypto Payment Events
export interface CryptoPaymentInitiatedProps {
  amount: number;
  currency: string;
  pay_currency: string;
  network?: string;
  organization_id: string;
  track_id: string;
}

export interface CryptoWalletConnectedProps {
  wallet_type: string;
  network: string;
  payment_id: string;
}

export interface CryptoPaymentSentProps {
  payment_id: string;
  track_id: string;
  tx_hash: string;
  network: string;
  token: string;
  amount: string;
}

export interface CryptoPaymentConfirmedProps {
  payment_method: "crypto";
  amount: number;
  currency: string;
  organization_id: string;
  credits_added: number;
  network: string;
  token: string;
  track_id: string;
  tx_hash?: string;
  validation_error?: boolean;
}

export interface CryptoPaymentExpiredProps {
  payment_id: string;
  track_id: string;
  organization_id: string;
  amount: number;
}

// App Credits Events
export interface AppCreditsCheckoutInitiatedProps {
  app_id: string;
  app_name?: string;
  amount: number;
  organization_id: string;
}

export interface AppCreditsPurchasedProps {
  app_id: string;
  app_name?: string;
  amount: number;
  credits_added: number;
  organization_id: string;
  platform_offset?: number;
  creator_earnings?: number;
}

// Auto Top-Up Events
export interface AutoTopupTriggeredProps {
  organization_id: string;
  current_balance: number;
  threshold: number;
  top_up_amount: number;
}

export interface AutoTopupCompletedProps {
  organization_id: string;
  amount: number;
  previous_balance: number;
  new_balance: number;
  payment_intent_id: string;
}

export interface AutoTopupFailedProps {
  organization_id: string;
  amount: number;
  error_reason: string;
}

// Checkout Funnel Events
export interface CheckoutAttemptedProps {
  payment_method: PaymentMethod;
  amount?: number;
  organization_id: string;
}

// Success/Invoice Events
export interface PaymentSuccessViewedProps {
  payment_method?: PaymentMethod;
  amount?: number;
  credits_added?: number;
  source: "stripe" | "crypto";
  session_id?: string;
  track_id?: string;
  dedup_id?: string; // Unique ID for PostHog event deduplication
}

export interface InvoiceViewedProps {
  invoice_id: string;
  amount: number;
  invoice_type: string;
}

export interface AgentChatMessageSentProps {
  agent_id: string;
  room_id: string;
  agent_name?: string;
  agent_mode?: string;
  has_attachments?: boolean;
  message_length: number;
}

export interface AgentCreateFailedProps {
  source: AgentSource;
  error_type?: string;
  error_message?: string;
}

export interface LoginCompletedProps {
  method: AuthMethod;
}

export type EventProperties =
  | SignupCompletedProps
  | LoginCompletedProps
  | AgentCreateStartedProps
  | AgentCreateCompletedProps
  | AgentCreateFailedProps
  | AgentEditStartedProps
  | AgentChatStartedProps
  | AgentChatMessageSentProps
  | ContainerDeployProps
  | ContainerShutdownInsufficientCreditsProps
  | ContainerShutdownWarningSentProps
  | ContainerDailyBilledProps
  | PageViewedProps
  | BillingPageViewedProps
  | CreditsPurchaseStartedProps
  | CreditsPurchasedProps
  // Payment Events
  | PaymentMethodSelectedProps
  | CheckoutInitiatedProps
  | CheckoutCompletedProps
  | CheckoutFailedProps
  // Crypto Events
  | CryptoPaymentInitiatedProps
  | CryptoWalletConnectedProps
  | CryptoPaymentSentProps
  | CryptoPaymentConfirmedProps
  | CryptoPaymentExpiredProps
  // App Credits Events
  | AppCreditsCheckoutInitiatedProps
  | AppCreditsPurchasedProps
  // Auto Top-Up Events
  | AutoTopupTriggeredProps
  | AutoTopupCompletedProps
  | AutoTopupFailedProps
  // Checkout Funnel Events
  | CheckoutAttemptedProps
  // Success/Invoice Events
  | PaymentSuccessViewedProps
  | InvoiceViewedProps;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function initPostHog(): void {
  if (!isBrowser()) return;

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

  // Initialize if key is set (allows staging/preview to opt-in)
  if (!apiKey) {
    if (isProduction()) {
      console.warn(
        "[PostHog] NEXT_PUBLIC_POSTHOG_KEY not set, analytics disabled",
      );
    }
    return;
  }

  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: false, // Disabled - using custom PageViewTracker component instead
    capture_pageleave: true,
    enable_recording_console_log: false,
    respect_dnt: true,
    persistence: "localStorage+cookie",
    mask_all_text: false,
    mask_all_element_attributes: false,
  });
}

export function trackEvent(
  event: PostHogEvent,
  properties?: EventProperties,
): void {
  if (!isBrowser()) return;
  posthog.capture(event, properties);
}

/**
 * Sanitize error messages before sending to analytics.
 * Removes stack traces, truncates to 200 chars, and takes only the first line.
 * This prevents leaking sensitive information like file paths or internal details.
 */
export function sanitizeErrorMessage(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  // Take first line only (removes stack traces), truncate to 200 chars
  return message.split("\n")[0].substring(0, 200);
}

export interface UserProperties {
  email?: string;
  name?: string;
  organization_id?: string;
  organization_name?: string;
  wallet_address?: string;
  signup_method?: string;
  created_at?: string;
}

export function identifyUser(
  userId: string,
  properties?: UserProperties,
): void {
  if (!isBrowser()) return;
  posthog.identify(userId, properties);
}

export function resetUser(): void {
  if (!isBrowser()) return;
  posthog.reset();
}

export function setUserProperties(properties: Record<string, unknown>): void {
  if (!isBrowser()) return;
  posthog.people.set(properties);
}

export function trackPageView(pageName?: string): void {
  if (!isBrowser()) return;
  posthog.capture("$pageview", {
    page_name: pageName,
    page_path: window.location.pathname,
  });
}

export function getPostHog(): typeof posthog | null {
  if (!isBrowser()) return null;
  return posthog;
}

export function isPostHogReady(): boolean {
  if (!isBrowser()) return false;
  return posthog.__loaded ?? false;
}
