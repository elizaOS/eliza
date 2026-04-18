import type { LifeOpsSubscriptionExecutor } from "./subscriptions-types.js";

export type SubscriptionAutomationStep =
  | {
      kind: "open";
      url: string;
    }
  | {
      kind: "navigate";
      url: string;
    }
  | {
      kind: "wait_text";
      text: string;
      timeoutMs?: number;
    }
  | {
      kind: "wait_selector";
      selector: string;
      timeoutMs?: number;
    }
  | {
      kind: "click_text";
      text: string;
      destructive?: boolean;
    }
  | {
      kind: "click_selector";
      selector: string;
      destructive?: boolean;
    }
  | {
      kind: "assert_text";
      text: string;
    }
  | {
      kind: "screenshot";
      label: string;
    };

export interface LifeOpsSubscriptionPlaybook {
  key: string;
  serviceName: string;
  aliases: string[];
  executorPreference: LifeOpsSubscriptionExecutor;
  managementUrl: string;
  managementPath?: string;
  auditDomains: string[];
  auditSubjectKeywords: string[];
  loginMarkers: string[];
  mfaMarkers: string[];
  phoneOnlyMarkers: string[];
  chatOnlyMarkers: string[];
  cancellationMarkers: string[];
  steps: SubscriptionAutomationStep[];
  companionSelectors?: {
    cancel?: string;
    confirm?: string;
  };
}

const FIXTURE_BASE_URL_ENV = "MILADY_SUBSCRIPTION_FIXTURE_BASE_URL";

function configuredFixtureBaseUrl(): string | null {
  const value = process.env[FIXTURE_BASE_URL_ENV]?.trim();
  if (!value) {
    return null;
  }
  return value.replace(/\/+$/, "");
}

function withFixtureOverride(path: string, fallback: string): string {
  const base = configuredFixtureBaseUrl();
  return base ? `${base}${path}` : fallback;
}

const GENERIC_LOGIN_MARKERS = [
  "sign in",
  "log in",
  "login",
  "password",
  "email address",
] as const;

const GENERIC_MFA_MARKERS = [
  "verification code",
  "two-factor",
  "2-step verification",
  "enter code",
] as const;

export const LIFEOPS_SUBSCRIPTION_PLAYBOOKS: readonly LifeOpsSubscriptionPlaybook[] =
  [
    {
      key: "google_play",
      serviceName: "Google Play",
      aliases: [
        "google play",
        "play store",
        "play subscriptions",
      ],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/stores/google-play",
        "https://play.google.com/store/account/subscriptions",
      ),
      managementPath: "/stores/google-play",
      auditDomains: ["google.com", "googleplay.com"],
      auditSubjectKeywords: [
        "google play",
        "subscription",
        "renewal",
        "receipt",
      ],
      loginMarkers: [...GENERIC_LOGIN_MARKERS],
      mfaMarkers: [...GENERIC_MFA_MARKERS],
      phoneOnlyMarkers: ["phone support"],
      chatOnlyMarkers: ["chat support"],
      cancellationMarkers: ["subscription canceled", "canceled on"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/stores/google-play",
            "https://play.google.com/store/account/subscriptions",
          ),
        },
        { kind: "wait_text", text: "Subscriptions" },
        { kind: "click_text", text: "Cancel subscription" },
        { kind: "wait_text", text: "Confirm cancellation" },
        { kind: "click_text", text: "Confirm cancellation", destructive: true },
        { kind: "wait_text", text: "subscription canceled" },
        { kind: "screenshot", label: "google-play-cancelled" },
      ],
      companionSelectors: {
        cancel: "[data-lifeops-action='cancel-subscription']",
        confirm: "[data-lifeops-action='confirm-cancellation']",
      },
    },
    {
      key: "apple_subscriptions",
      serviceName: "Apple subscriptions",
      aliases: [
        "apple subscriptions",
        "app store",
        "itunes subscription",
        "apple services",
      ],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/stores/apple-subscriptions",
        "https://account.apple.com/account/manage/section/subscriptions",
      ),
      managementPath: "/stores/apple-subscriptions",
      auditDomains: ["apple.com", "itunes.com"],
      auditSubjectKeywords: [
        "app store",
        "apple subscription",
        "renewal receipt",
      ],
      loginMarkers: [...GENERIC_LOGIN_MARKERS, "apple id"],
      mfaMarkers: [...GENERIC_MFA_MARKERS, "trusted device"],
      phoneOnlyMarkers: ["contact apple support by phone"],
      chatOnlyMarkers: ["chat with apple support"],
      cancellationMarkers: ["subscription canceled", "expires on"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/stores/apple-subscriptions",
            "https://account.apple.com/account/manage/section/subscriptions",
          ),
        },
        { kind: "wait_text", text: "Subscriptions" },
        { kind: "click_text", text: "Cancel subscription" },
        { kind: "wait_text", text: "Confirm cancellation" },
        { kind: "click_text", text: "Confirm cancellation", destructive: true },
        { kind: "wait_text", text: "subscription canceled" },
        { kind: "screenshot", label: "apple-subscriptions-cancelled" },
      ],
      companionSelectors: {
        cancel: "[data-lifeops-action='cancel-subscription']",
        confirm: "[data-lifeops-action='confirm-cancellation']",
      },
    },
    {
      key: "netflix",
      serviceName: "Netflix",
      aliases: ["netflix", "netflix subscription", "netflix billing"],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/services/netflix",
        "https://www.netflix.com/manageaccount",
      ),
      managementPath: "/services/netflix",
      auditDomains: ["netflix.com"],
      auditSubjectKeywords: ["netflix", "membership", "receipt", "billing"],
      loginMarkers: [...GENERIC_LOGIN_MARKERS],
      mfaMarkers: [...GENERIC_MFA_MARKERS],
      phoneOnlyMarkers: ["call us to cancel"],
      chatOnlyMarkers: ["chat with support to cancel"],
      cancellationMarkers: ["subscription canceled"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/services/netflix",
            "https://www.netflix.com/manageaccount",
          ),
        },
        { kind: "wait_text", text: "Subscriptions" },
        { kind: "click_text", text: "Cancel subscription" },
        { kind: "wait_text", text: "Confirm cancellation" },
        { kind: "click_text", text: "Confirm cancellation", destructive: true },
        { kind: "wait_text", text: "subscription canceled" },
        { kind: "screenshot", label: "netflix-cancelled" },
      ],
      companionSelectors: {
        cancel: "[data-lifeops-action='cancel-subscription']",
        confirm: "[data-lifeops-action='confirm-cancellation']",
      },
    },
    {
      key: "hulu",
      serviceName: "Hulu",
      aliases: ["hulu", "hulu subscription", "hulu billing"],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/services/hulu",
        "https://secure.hulu.com/account",
      ),
      managementPath: "/services/hulu",
      auditDomains: ["hulu.com"],
      auditSubjectKeywords: ["hulu", "subscription", "receipt", "billing"],
      loginMarkers: [...GENERIC_LOGIN_MARKERS],
      mfaMarkers: [...GENERIC_MFA_MARKERS],
      phoneOnlyMarkers: ["call us to cancel"],
      chatOnlyMarkers: ["chat with support to cancel"],
      cancellationMarkers: ["subscription canceled"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/services/hulu",
            "https://secure.hulu.com/account",
          ),
        },
        { kind: "wait_text", text: "Subscriptions" },
        { kind: "click_text", text: "Cancel subscription" },
        { kind: "wait_text", text: "Confirm cancellation" },
        { kind: "click_text", text: "Confirm cancellation", destructive: true },
        { kind: "wait_text", text: "subscription canceled" },
        { kind: "screenshot", label: "hulu-cancelled" },
      ],
      companionSelectors: {
        cancel: "[data-lifeops-action='cancel-subscription']",
        confirm: "[data-lifeops-action='confirm-cancellation']",
      },
    },
    {
      key: "fixture_streaming",
      serviceName: "Fixture Streaming",
      aliases: [
        "fixture streaming",
        "streaming fixture",
        "test streaming",
      ],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/services/fixture-streaming",
        "https://example.com/account/subscription",
      ),
      managementPath: "/services/fixture-streaming",
      auditDomains: ["fixture-streaming.example"],
      auditSubjectKeywords: ["fixture streaming", "monthly plan", "receipt"],
      loginMarkers: [...GENERIC_LOGIN_MARKERS],
      mfaMarkers: [...GENERIC_MFA_MARKERS],
      phoneOnlyMarkers: ["call us to cancel"],
      chatOnlyMarkers: ["chat with support to cancel"],
      cancellationMarkers: ["subscription canceled"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/services/fixture-streaming",
            "https://example.com/account/subscription",
          ),
        },
        { kind: "wait_text", text: "Fixture Streaming" },
        { kind: "click_text", text: "Cancel subscription" },
        { kind: "wait_text", text: "Confirm cancellation" },
        { kind: "click_text", text: "Confirm cancellation", destructive: true },
        { kind: "wait_text", text: "subscription canceled" },
        { kind: "screenshot", label: "fixture-streaming-cancelled" },
      ],
      companionSelectors: {
        cancel: "[data-lifeops-action='cancel-subscription']",
        confirm: "[data-lifeops-action='confirm-cancellation']",
      },
    },
    {
      key: "fixture_login_required",
      serviceName: "Fixture Access Wall",
      aliases: [
        "fixture access wall",
        "test access wall",
        "fixture sign in handoff",
        "fixture sign-in handoff",
        "test sign in handoff",
        "test sign-in handoff",
      ],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/services/login-required",
        "https://example.com/account/subscription",
      ),
      managementPath: "/services/login-required",
      auditDomains: ["login-required.example"],
      auditSubjectKeywords: ["login required", "membership receipt"],
      loginMarkers: [...GENERIC_LOGIN_MARKERS],
      mfaMarkers: [...GENERIC_MFA_MARKERS],
      phoneOnlyMarkers: [],
      chatOnlyMarkers: [],
      cancellationMarkers: ["subscription canceled"],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/services/login-required",
            "https://example.com/account/subscription",
          ),
        },
        { kind: "wait_text", text: "Sign in to continue" },
      ],
      companionSelectors: {},
    },
    {
      key: "fixture_phone_only",
      serviceName: "Fixture Phone Only",
      aliases: ["fixture phone only", "test phone only"],
      executorPreference: "agent_browser",
      managementUrl: withFixtureOverride(
        "/services/phone-only",
        "https://example.com/account/subscription",
      ),
      managementPath: "/services/phone-only",
      auditDomains: ["phone-only.example"],
      auditSubjectKeywords: ["phone only", "billing receipt"],
      loginMarkers: [],
      mfaMarkers: [],
      phoneOnlyMarkers: ["call us to cancel"],
      chatOnlyMarkers: [],
      cancellationMarkers: [],
      steps: [
        {
          kind: "open",
          url: withFixtureOverride(
            "/services/phone-only",
            "https://example.com/account/subscription",
          ),
        },
        { kind: "wait_text", text: "Call us to cancel" },
      ],
      companionSelectors: {},
    },
  ] as const;

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function listLifeOpsSubscriptionPlaybooks(): readonly LifeOpsSubscriptionPlaybook[] {
  return LIFEOPS_SUBSCRIPTION_PLAYBOOKS;
}

export function findLifeOpsSubscriptionPlaybook(
  serviceNameOrSlug: string | null | undefined,
): LifeOpsSubscriptionPlaybook | null {
  if (!serviceNameOrSlug) {
    return null;
  }
  const normalized = normalizeName(serviceNameOrSlug);
  for (const playbook of LIFEOPS_SUBSCRIPTION_PLAYBOOKS) {
    if (normalizeName(playbook.key) === normalized) {
      return playbook;
    }
    if (normalizeName(playbook.serviceName) === normalized) {
      return playbook;
    }
    if (playbook.aliases.some((alias) => normalizeName(alias) === normalized)) {
      return playbook;
    }
    if (
      normalized.includes(normalizeName(playbook.key)) ||
      normalized.includes(normalizeName(playbook.serviceName)) ||
      playbook.aliases.some((alias) =>
        normalized.includes(normalizeName(alias)),
      )
    ) {
      return playbook;
    }
  }
  return null;
}
