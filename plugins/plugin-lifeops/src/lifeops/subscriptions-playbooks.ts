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

export type SubscriptionCancellationCapability =
  | {
      kind: "executable_playbook";
      label: "Executable cancellation playbook";
      executionSurface: "browser_steps";
      manualFallback: false;
    }
  | {
      kind: "management_url_manual_fallback";
      label: "Management URL manual fallback";
      executionSurface: "management_url";
      manualFallback: true;
      reason: "no_verified_click_flow";
    };

export interface LifeOpsSubscriptionPlaybook {
  key: string;
  serviceName: string;
  aliases: string[];
  executorPreference: LifeOpsSubscriptionExecutor;
  cancellationCapability: SubscriptionCancellationCapability;
  managementUrl: string;
  managementPath?: string;
  auditDomains: string[];
  auditSubjectKeywords: string[];
  loginMarkers: string[];
  mfaMarkers: string[];
  phoneOnlyMarkers: string[];
  chatOnlyMarkers: string[];
  cancellationMarkers: string[];
  /**
   * Concrete browser automation steps. When undefined, the service has no
   * real click-flow implemented — the caller must report a
   * `PLAYBOOK_NOT_IMPLEMENTED` failure rather than pretend to cancel.
   */
  steps?: SubscriptionAutomationStep[];
  companionSelectors?: {
    cancel?: string;
    confirm?: string;
  };
}

const FIXTURE_BASE_URL_ENV = "ELIZA_SUBSCRIPTION_FIXTURE_BASE_URL";

/**
 * Error-code prefix used by the subscriptions mixin and action when a
 * playbook is registered (we know the management URL) but no concrete
 * click-flow has been implemented yet. Shared with the action so callers
 * can pattern-match structured failures instead of parsing free text.
 */
export const PLAYBOOK_NOT_IMPLEMENTED_ERROR = "PLAYBOOK_NOT_IMPLEMENTED";

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

const GENERIC_CANCELLATION_MARKERS = [
  "canceled",
  "cancelled",
  "subscription ended",
  "membership ended",
  "membership canceled",
  "subscription canceled",
  "cancellation confirmed",
  "you won't be charged",
  "your plan ends",
];

const EXECUTABLE_PLAYBOOK_CAPABILITY = {
  kind: "executable_playbook",
  label: "Executable cancellation playbook",
  executionSurface: "browser_steps",
  manualFallback: false,
} as const satisfies SubscriptionCancellationCapability;

const MANAGEMENT_URL_MANUAL_FALLBACK_CAPABILITY = {
  kind: "management_url_manual_fallback",
  label: "Management URL manual fallback",
  executionSurface: "management_url",
  manualFallback: true,
  reason: "no_verified_click_flow",
} as const satisfies SubscriptionCancellationCapability;

function cancellationCapabilityForSteps(
  steps: SubscriptionAutomationStep[] | undefined,
): SubscriptionCancellationCapability {
  return steps && steps.length > 0
    ? { ...EXECUTABLE_PLAYBOOK_CAPABILITY }
    : { ...MANAGEMENT_URL_MANUAL_FALLBACK_CAPABILITY };
}

/**
 * Build a management-URL-only playbook for services where the cancellation
 * flow is behind login, retention offers, or app-store ownership. This covers
 * the long tail of popular subscriptions without pretending URL knowledge is
 * the same as a verified click-flow.
 */
function definePlaybook(
  partial: Pick<
    LifeOpsSubscriptionPlaybook,
    | "key"
    | "serviceName"
    | "aliases"
    | "managementUrl"
    | "auditDomains"
    | "auditSubjectKeywords"
  > &
    Partial<
      Pick<
        LifeOpsSubscriptionPlaybook,
        | "executorPreference"
        | "managementPath"
        | "loginMarkers"
        | "mfaMarkers"
        | "phoneOnlyMarkers"
        | "chatOnlyMarkers"
        | "cancellationMarkers"
        | "steps"
        | "companionSelectors"
      >
    >,
): LifeOpsSubscriptionPlaybook {
  const managementUrl = partial.managementUrl;
  return {
    key: partial.key,
    serviceName: partial.serviceName,
    aliases: partial.aliases,
    executorPreference: partial.executorPreference ?? "user_browser",
    cancellationCapability: cancellationCapabilityForSteps(partial.steps),
    managementUrl,
    managementPath: partial.managementPath,
    auditDomains: partial.auditDomains,
    auditSubjectKeywords: partial.auditSubjectKeywords,
    loginMarkers: partial.loginMarkers ?? [...GENERIC_LOGIN_MARKERS],
    mfaMarkers: partial.mfaMarkers ?? [...GENERIC_MFA_MARKERS],
    phoneOnlyMarkers: partial.phoneOnlyMarkers ?? [],
    chatOnlyMarkers: partial.chatOnlyMarkers ?? [],
    cancellationMarkers:
      partial.cancellationMarkers ?? GENERIC_CANCELLATION_MARKERS,
    // No default steps: opening the management URL + a screenshot is NOT a
    // cancellation. Services without an explicit click-flow are handled by
    // the caller as PLAYBOOK_NOT_IMPLEMENTED so we don't silently report
    // fake success. See service-mixin-subscriptions.ts.
    steps: partial.steps,
    companionSelectors: partial.companionSelectors,
  };
}

export const LIFEOPS_SUBSCRIPTION_PLAYBOOKS: readonly LifeOpsSubscriptionPlaybook[] =
  [
    {
      key: "google_play",
      serviceName: "Google Play",
      aliases: ["google play", "play store", "play subscriptions"],
      executorPreference: "agent_browser",
      cancellationCapability: { ...EXECUTABLE_PLAYBOOK_CAPABILITY },
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
      cancellationCapability: { ...EXECUTABLE_PLAYBOOK_CAPABILITY },
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
      key: "fixture_streaming",
      serviceName: "Fixture Streaming",
      aliases: ["fixture streaming", "streaming fixture", "test streaming"],
      executorPreference: "agent_browser",
      cancellationCapability: { ...EXECUTABLE_PLAYBOOK_CAPABILITY },
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
      cancellationCapability: { ...EXECUTABLE_PLAYBOOK_CAPABILITY },
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
      cancellationCapability: { ...EXECUTABLE_PLAYBOOK_CAPABILITY },
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

    // ---- Streaming video ---------------------------------------------------
    definePlaybook({
      key: "netflix",
      serviceName: "Netflix",
      aliases: ["netflix"],
      managementUrl: "https://www.netflix.com/cancelplan",
      auditDomains: ["netflix.com"],
      auditSubjectKeywords: ["netflix", "your monthly charge", "membership"],
    }),
    definePlaybook({
      key: "hulu",
      serviceName: "Hulu",
      aliases: ["hulu"],
      managementUrl: "https://secure.hulu.com/account/cancel",
      auditDomains: ["hulu.com"],
      auditSubjectKeywords: ["hulu", "your hulu receipt"],
    }),
    definePlaybook({
      key: "disney_plus",
      serviceName: "Disney+",
      aliases: ["disney plus", "disneyplus", "disney+"],
      managementUrl: "https://www.disneyplus.com/account/subscription",
      auditDomains: ["disneyplus.com", "mail.disneyplus.com"],
      auditSubjectKeywords: [
        "disney+",
        "disney plus",
        "your disney+ subscription",
      ],
    }),
    definePlaybook({
      key: "max_hbo",
      serviceName: "Max (HBO)",
      aliases: ["max", "hbo max", "hbomax"],
      managementUrl: "https://auth.max.com/my-account",
      auditDomains: ["max.com", "hbomax.com", "mail.max.com"],
      auditSubjectKeywords: ["max", "hbo max", "your max subscription"],
    }),
    definePlaybook({
      key: "peacock",
      serviceName: "Peacock",
      aliases: ["peacock", "peacock tv"],
      managementUrl: "https://www.peacocktv.com/account/plans",
      auditDomains: ["peacocktv.com", "nbcuni.com"],
      auditSubjectKeywords: ["peacock", "your peacock plan"],
    }),
    definePlaybook({
      key: "paramount_plus",
      serviceName: "Paramount+",
      aliases: ["paramount plus", "paramount+"],
      managementUrl: "https://www.paramountplus.com/account/subscription",
      auditDomains: ["paramountplus.com", "cbs.com"],
      auditSubjectKeywords: ["paramount+", "paramount plus"],
    }),
    definePlaybook({
      key: "apple_tv_plus",
      serviceName: "Apple TV+",
      aliases: ["apple tv+", "apple tv plus", "tv+"],
      managementUrl: "https://tv.apple.com/account",
      auditDomains: ["apple.com", "itunes.com"],
      auditSubjectKeywords: ["apple tv+", "apple tv plus"],
    }),
    definePlaybook({
      key: "amazon_prime_video",
      serviceName: "Amazon Prime Video",
      aliases: ["amazon prime video", "prime video"],
      managementUrl: "https://www.amazon.com/gp/video/settings",
      auditDomains: ["amazon.com", "primevideo.com"],
      auditSubjectKeywords: ["prime video", "amazon video"],
    }),
    definePlaybook({
      key: "amazon_prime",
      serviceName: "Amazon Prime",
      aliases: ["amazon prime", "prime membership"],
      managementUrl:
        "https://www.amazon.com/gp/help/customer/contact-us/?nodeId=G34EUPKVMYFW8N2U",
      auditDomains: ["amazon.com"],
      auditSubjectKeywords: ["your amazon prime", "prime membership"],
    }),
    definePlaybook({
      key: "youtube_premium",
      serviceName: "YouTube Premium",
      aliases: ["youtube premium", "yt premium", "youtube music premium"],
      managementUrl: "https://www.youtube.com/paid_memberships",
      auditDomains: ["youtube.com", "google.com"],
      auditSubjectKeywords: ["youtube premium", "youtube music"],
    }),
    definePlaybook({
      key: "crunchyroll",
      serviceName: "Crunchyroll",
      aliases: ["crunchyroll"],
      managementUrl: "https://www.crunchyroll.com/account/membership",
      auditDomains: ["crunchyroll.com"],
      auditSubjectKeywords: ["crunchyroll", "premium subscription"],
    }),
    definePlaybook({
      key: "espn_plus",
      serviceName: "ESPN+",
      aliases: ["espn+", "espn plus"],
      managementUrl: "https://www.espn.com/watch/account",
      auditDomains: ["espn.com"],
      auditSubjectKeywords: ["espn+", "espn plus"],
    }),

    // ---- Music -------------------------------------------------------------
    definePlaybook({
      key: "spotify",
      serviceName: "Spotify",
      aliases: ["spotify", "spotify premium"],
      managementUrl: "https://www.spotify.com/account/subscription/",
      auditDomains: ["spotify.com"],
      auditSubjectKeywords: ["spotify", "premium receipt"],
    }),
    definePlaybook({
      key: "apple_music",
      serviceName: "Apple Music",
      aliases: ["apple music"],
      managementUrl: "https://music.apple.com/account/settings",
      auditDomains: ["apple.com", "itunes.com"],
      auditSubjectKeywords: ["apple music"],
    }),
    definePlaybook({
      key: "tidal",
      serviceName: "Tidal",
      aliases: ["tidal"],
      managementUrl: "https://listen.tidal.com/account/subscription",
      auditDomains: ["tidal.com"],
      auditSubjectKeywords: ["tidal", "your tidal subscription"],
    }),
    definePlaybook({
      key: "pandora",
      serviceName: "Pandora",
      aliases: ["pandora", "pandora premium", "pandora plus"],
      managementUrl: "https://www.pandora.com/account/subscription",
      auditDomains: ["pandora.com"],
      auditSubjectKeywords: ["pandora", "pandora premium", "pandora plus"],
    }),
    definePlaybook({
      key: "siriusxm",
      serviceName: "SiriusXM",
      aliases: ["siriusxm", "sirius xm", "sirius"],
      managementUrl: "https://www.siriusxm.com/account/managesubscriptions",
      auditDomains: ["siriusxm.com"],
      auditSubjectKeywords: ["siriusxm", "your sirius"],
      phoneOnlyMarkers: ["call to cancel", "1-866-635-5027"],
    }),

    // ---- News / media ------------------------------------------------------
    definePlaybook({
      key: "nytimes",
      serviceName: "The New York Times",
      aliases: ["nyt", "new york times", "nytimes"],
      managementUrl: "https://www.nytimes.com/subscription/manage/downgrade",
      auditDomains: ["nytimes.com"],
      auditSubjectKeywords: ["new york times", "nyt subscription"],
      chatOnlyMarkers: ["chat with us"],
    }),
    definePlaybook({
      key: "wsj",
      serviceName: "Wall Street Journal",
      aliases: ["wsj", "wall street journal"],
      managementUrl: "https://customercenter.wsj.com/view/subscriptions.html",
      auditDomains: ["wsj.com", "dowjones.com"],
      auditSubjectKeywords: ["wsj", "wall street journal"],
    }),
    definePlaybook({
      key: "washington_post",
      serviceName: "The Washington Post",
      aliases: ["wapo", "washington post", "washingtonpost"],
      managementUrl:
        "https://subscribe.washingtonpost.com/profile/subscription",
      auditDomains: ["washingtonpost.com"],
      auditSubjectKeywords: ["washington post", "wapo subscription"],
    }),
    definePlaybook({
      key: "the_atlantic",
      serviceName: "The Atlantic",
      aliases: ["the atlantic", "atlantic subscription"],
      managementUrl: "https://accounts.theatlantic.com/account/subscription/",
      auditDomains: ["theatlantic.com"],
      auditSubjectKeywords: ["the atlantic", "atlantic subscription"],
    }),
    definePlaybook({
      key: "medium",
      serviceName: "Medium",
      aliases: ["medium", "medium membership"],
      managementUrl: "https://medium.com/me/membership",
      auditDomains: ["medium.com"],
      auditSubjectKeywords: ["medium membership", "medium receipt"],
    }),
    definePlaybook({
      key: "substack",
      serviceName: "Substack",
      aliases: ["substack"],
      managementUrl: "https://substack.com/account",
      auditDomains: ["substack.com"],
      auditSubjectKeywords: ["substack", "your substack subscription"],
    }),
    definePlaybook({
      key: "bloomberg",
      serviceName: "Bloomberg",
      aliases: ["bloomberg", "bloomberg subscription"],
      managementUrl: "https://www.bloomberg.com/account/subscriptions",
      auditDomains: ["bloomberg.com"],
      auditSubjectKeywords: ["bloomberg", "bloomberg subscription"],
    }),

    // ---- Software / Cloud --------------------------------------------------
    definePlaybook({
      key: "icloud",
      serviceName: "iCloud+",
      aliases: ["icloud", "icloud+", "icloud plus"],
      managementUrl: "https://www.icloud.com/settings/storage",
      auditDomains: ["apple.com", "icloud.com"],
      auditSubjectKeywords: ["icloud", "your icloud storage"],
    }),
    definePlaybook({
      key: "google_one",
      serviceName: "Google One",
      aliases: ["google one", "googleone"],
      managementUrl: "https://one.google.com/storage/management",
      auditDomains: ["google.com"],
      auditSubjectKeywords: ["google one", "storage plan"],
    }),
    definePlaybook({
      key: "dropbox",
      serviceName: "Dropbox",
      aliases: ["dropbox", "dropbox plus"],
      managementUrl: "https://www.dropbox.com/account/plan",
      auditDomains: ["dropbox.com"],
      auditSubjectKeywords: ["dropbox", "your dropbox plan"],
    }),
    definePlaybook({
      key: "microsoft_365",
      serviceName: "Microsoft 365",
      aliases: ["microsoft 365", "office 365", "m365"],
      managementUrl: "https://account.microsoft.com/services/",
      auditDomains: ["microsoft.com"],
      auditSubjectKeywords: ["microsoft 365", "office 365"],
    }),
    definePlaybook({
      key: "adobe_creative_cloud",
      serviceName: "Adobe Creative Cloud",
      aliases: [
        "adobe",
        "adobe creative cloud",
        "creative cloud",
        "photoshop subscription",
      ],
      managementUrl: "https://account.adobe.com/plans",
      auditDomains: ["adobe.com"],
      auditSubjectKeywords: ["adobe", "creative cloud"],
      chatOnlyMarkers: ["chat with agent"],
    }),
    definePlaybook({
      key: "canva",
      serviceName: "Canva",
      aliases: ["canva", "canva pro"],
      managementUrl: "https://www.canva.com/account/subscription/",
      auditDomains: ["canva.com"],
      auditSubjectKeywords: ["canva", "your canva pro"],
    }),
    definePlaybook({
      key: "notion",
      serviceName: "Notion",
      aliases: ["notion", "notion plus", "notion personal pro"],
      managementUrl: "https://www.notion.so/my-plan",
      auditDomains: ["notion.so"],
      auditSubjectKeywords: ["notion", "your notion plan"],
    }),
    definePlaybook({
      key: "evernote",
      serviceName: "Evernote",
      aliases: ["evernote", "evernote premium"],
      managementUrl: "https://www.evernote.com/AccountSummary.action",
      auditDomains: ["evernote.com"],
      auditSubjectKeywords: ["evernote"],
    }),
    definePlaybook({
      key: "onepassword",
      serviceName: "1Password",
      aliases: ["1password", "one password"],
      managementUrl: "https://my.1password.com/billing",
      auditDomains: ["1password.com"],
      auditSubjectKeywords: ["1password", "your 1password membership"],
    }),

    // ---- Gaming ------------------------------------------------------------
    definePlaybook({
      key: "xbox_game_pass",
      serviceName: "Xbox Game Pass",
      aliases: ["xbox game pass", "game pass", "xbox live"],
      managementUrl: "https://account.microsoft.com/services/",
      auditDomains: ["microsoft.com", "xbox.com"],
      auditSubjectKeywords: ["xbox", "game pass"],
    }),
    definePlaybook({
      key: "playstation_plus",
      serviceName: "PlayStation Plus",
      aliases: ["ps plus", "playstation plus", "ps+"],
      managementUrl:
        "https://www.playstation.com/en-us/support/subscriptions/playstation-plus-cancel/",
      auditDomains: ["playstation.com", "sony.com"],
      auditSubjectKeywords: ["playstation plus", "ps plus"],
    }),
    definePlaybook({
      key: "nintendo_switch_online",
      serviceName: "Nintendo Switch Online",
      aliases: ["nintendo switch online", "nso", "nintendo online"],
      managementUrl: "https://accounts.nintendo.com/subscription/management",
      auditDomains: ["nintendo.com"],
      auditSubjectKeywords: ["nintendo switch online", "nso"],
    }),
    definePlaybook({
      key: "ea_play",
      serviceName: "EA Play",
      aliases: ["ea play", "ea access", "origin access"],
      managementUrl: "https://www.ea.com/ea-play/manage-subscription",
      auditDomains: ["ea.com"],
      auditSubjectKeywords: ["ea play", "ea access"],
    }),

    // ---- AI / developer ----------------------------------------------------
    definePlaybook({
      key: "chatgpt_plus",
      serviceName: "ChatGPT Plus",
      aliases: [
        "chatgpt plus",
        "chatgpt",
        "openai plus",
        "chatgpt subscription",
      ],
      managementUrl: "https://chatgpt.com/#settings/Subscription",
      auditDomains: ["openai.com", "chatgpt.com"],
      auditSubjectKeywords: ["chatgpt plus", "openai receipt", "your chatgpt"],
    }),
    definePlaybook({
      key: "claude_pro",
      serviceName: "Claude Pro",
      aliases: ["claude pro", "anthropic", "claude subscription"],
      managementUrl: "https://claude.ai/settings/billing",
      auditDomains: ["anthropic.com", "claude.ai"],
      auditSubjectKeywords: ["claude pro", "anthropic receipt"],
    }),
    definePlaybook({
      key: "github_copilot",
      serviceName: "GitHub Copilot",
      aliases: ["github copilot", "copilot", "github"],
      managementUrl: "https://github.com/settings/copilot",
      auditDomains: ["github.com"],
      auditSubjectKeywords: ["github copilot", "your copilot"],
    }),
    definePlaybook({
      key: "perplexity_pro",
      serviceName: "Perplexity Pro",
      aliases: ["perplexity", "perplexity pro"],
      managementUrl: "https://www.perplexity.ai/settings/account",
      auditDomains: ["perplexity.ai"],
      auditSubjectKeywords: ["perplexity", "your perplexity pro"],
    }),

    // ---- Fitness / health --------------------------------------------------
    definePlaybook({
      key: "peloton",
      serviceName: "Peloton",
      aliases: ["peloton", "peloton app", "peloton membership"],
      managementUrl:
        "https://members.onepeloton.com/preferences/account/subscription",
      auditDomains: ["onepeloton.com"],
      auditSubjectKeywords: ["peloton", "membership receipt"],
    }),
    definePlaybook({
      key: "apple_fitness_plus",
      serviceName: "Apple Fitness+",
      aliases: ["apple fitness+", "apple fitness plus", "fitness+"],
      managementUrl: "https://fitness.apple.com/account",
      auditDomains: ["apple.com", "itunes.com"],
      auditSubjectKeywords: ["apple fitness+", "fitness plus"],
    }),
    definePlaybook({
      key: "strava_premium",
      serviceName: "Strava Premium",
      aliases: ["strava", "strava premium", "strava subscription"],
      managementUrl: "https://www.strava.com/settings/billing",
      auditDomains: ["strava.com"],
      auditSubjectKeywords: ["strava", "your strava subscription"],
    }),
    definePlaybook({
      key: "myfitnesspal_premium",
      serviceName: "MyFitnessPal Premium",
      aliases: ["myfitnesspal", "mfp premium", "mfp"],
      managementUrl: "https://www.myfitnesspal.com/account/premium",
      auditDomains: ["myfitnesspal.com"],
      auditSubjectKeywords: ["myfitnesspal", "mfp premium"],
    }),
    definePlaybook({
      key: "calm",
      serviceName: "Calm",
      aliases: ["calm app", "calm subscription"],
      managementUrl: "https://app.www.calm.com/settings/subscription",
      auditDomains: ["calm.com"],
      auditSubjectKeywords: ["calm", "your calm subscription"],
    }),
    definePlaybook({
      key: "headspace",
      serviceName: "Headspace",
      aliases: ["headspace"],
      managementUrl: "https://www.headspace.com/subscription/details",
      auditDomains: ["headspace.com"],
      auditSubjectKeywords: ["headspace", "your headspace"],
    }),
    definePlaybook({
      key: "noom",
      serviceName: "Noom",
      aliases: ["noom"],
      managementUrl: "https://www.noom.com/myaccount",
      auditDomains: ["noom.com"],
      auditSubjectKeywords: ["noom"],
      chatOnlyMarkers: ["noom coach", "message to cancel"],
    }),

    // ---- Meal / food -------------------------------------------------------
    definePlaybook({
      key: "hellofresh",
      serviceName: "HelloFresh",
      aliases: ["hellofresh", "hello fresh"],
      managementUrl: "https://www.hellofresh.com/account-settings/subscription",
      auditDomains: ["hellofresh.com"],
      auditSubjectKeywords: ["hellofresh", "your hellofresh order"],
    }),
    definePlaybook({
      key: "blue_apron",
      serviceName: "Blue Apron",
      aliases: ["blue apron"],
      managementUrl: "https://www.blueapron.com/users/edit",
      auditDomains: ["blueapron.com"],
      auditSubjectKeywords: ["blue apron"],
    }),
    definePlaybook({
      key: "factor",
      serviceName: "Factor",
      aliases: ["factor", "factor 75"],
      managementUrl: "https://www.factor75.com/account/subscription",
      auditDomains: ["factor75.com", "factormeals.com"],
      auditSubjectKeywords: ["factor", "your factor order"],
    }),
    definePlaybook({
      key: "doordash_dashpass",
      serviceName: "DoorDash DashPass",
      aliases: ["doordash", "dashpass"],
      managementUrl: "https://www.doordash.com/dashpass/manage",
      auditDomains: ["doordash.com"],
      auditSubjectKeywords: ["doordash", "dashpass"],
    }),
    definePlaybook({
      key: "uber_one",
      serviceName: "Uber One",
      aliases: ["uber one", "uber eats pass"],
      managementUrl: "https://www.uber.com/go/uber-one-manage",
      auditDomains: ["uber.com"],
      auditSubjectKeywords: ["uber one", "uber eats pass"],
    }),
    definePlaybook({
      key: "instacart_plus",
      serviceName: "Instacart+",
      aliases: ["instacart", "instacart plus", "instacart+"],
      managementUrl: "https://www.instacart.com/store/account/instacart-plus",
      auditDomains: ["instacart.com"],
      auditSubjectKeywords: ["instacart+", "instacart plus"],
    }),
    definePlaybook({
      key: "grubhub_plus",
      serviceName: "Grubhub+",
      aliases: ["grubhub", "grubhub+", "grubhub plus"],
      managementUrl: "https://www.grubhub.com/grubhub-plus-membership",
      auditDomains: ["grubhub.com"],
      auditSubjectKeywords: ["grubhub+", "grubhub plus"],
    }),

    // ---- Other consumer ----------------------------------------------------
    definePlaybook({
      key: "audible",
      serviceName: "Audible",
      aliases: [
        "audible",
        "audible membership",
        "audible plus",
        "audible premium plus",
      ],
      managementUrl: "https://www.audible.com/account/membership-details",
      auditDomains: ["audible.com", "amazon.com"],
      auditSubjectKeywords: ["audible", "audible membership"],
    }),
    definePlaybook({
      key: "kindle_unlimited",
      serviceName: "Kindle Unlimited",
      aliases: ["kindle unlimited", "ku"],
      managementUrl: "https://www.amazon.com/kindleunlimited/manage",
      auditDomains: ["amazon.com"],
      auditSubjectKeywords: ["kindle unlimited"],
    }),
    definePlaybook({
      key: "linkedin_premium",
      serviceName: "LinkedIn Premium",
      aliases: ["linkedin premium", "linkedin"],
      managementUrl: "https://www.linkedin.com/premium/manage/",
      auditDomains: ["linkedin.com"],
      auditSubjectKeywords: ["linkedin premium", "your linkedin premium"],
    }),
    definePlaybook({
      key: "duolingo_plus",
      serviceName: "Duolingo Super",
      aliases: ["duolingo", "duolingo plus", "duolingo super"],
      managementUrl: "https://www.duolingo.com/settings/super",
      auditDomains: ["duolingo.com"],
      auditSubjectKeywords: ["duolingo"],
    }),
    definePlaybook({
      key: "grammarly_premium",
      serviceName: "Grammarly Premium",
      aliases: ["grammarly", "grammarly premium"],
      managementUrl: "https://account.grammarly.com/subscription",
      auditDomains: ["grammarly.com"],
      auditSubjectKeywords: ["grammarly", "your grammarly subscription"],
    }),
    definePlaybook({
      key: "tinder",
      serviceName: "Tinder",
      aliases: ["tinder", "tinder gold", "tinder plus"],
      managementUrl: "https://tinder.com/app/settings",
      auditDomains: ["tinder.com"],
      auditSubjectKeywords: ["tinder", "tinder gold", "tinder plus"],
    }),
    definePlaybook({
      key: "bumble",
      serviceName: "Bumble",
      aliases: ["bumble", "bumble premium", "bumble boost"],
      managementUrl: "https://bumble.com/app/settings",
      auditDomains: ["bumble.com"],
      auditSubjectKeywords: ["bumble"],
    }),
    definePlaybook({
      key: "hinge",
      serviceName: "Hinge",
      aliases: ["hinge", "hinge preferred"],
      managementUrl: "https://hinge.co/subscription",
      auditDomains: ["hinge.co"],
      auditSubjectKeywords: ["hinge"],
    }),
    definePlaybook({
      key: "masterclass",
      serviceName: "MasterClass",
      aliases: ["masterclass"],
      managementUrl: "https://www.masterclass.com/account",
      auditDomains: ["masterclass.com"],
      auditSubjectKeywords: ["masterclass"],
    }),
    definePlaybook({
      key: "skillshare",
      serviceName: "Skillshare",
      aliases: ["skillshare"],
      managementUrl: "https://www.skillshare.com/settings/payments",
      auditDomains: ["skillshare.com"],
      auditSubjectKeywords: ["skillshare"],
    }),
    definePlaybook({
      key: "coursera_plus",
      serviceName: "Coursera Plus",
      aliases: ["coursera", "coursera plus"],
      managementUrl: "https://www.coursera.org/account-settings",
      auditDomains: ["coursera.org"],
      auditSubjectKeywords: ["coursera plus", "your coursera"],
    }),
  ];

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
