import type { MockEnvironmentName } from "../scripts/start-mocks.ts";

export type LifeOpsProviderMockMode =
  | "stateful-http"
  | "static-http"
  | "dependency-seam"
  | "browser-workspace";

export interface LifeOpsProviderMockCoverage {
  id: string;
  label: string;
  mode: LifeOpsProviderMockMode;
  environment: MockEnvironmentName | null;
  envVars: readonly string[];
  surfaces: readonly string[];
  knownGaps: readonly string[];
  validation: readonly string[];
  rationale?: string;
}

export const REQUIRED_LIFEOPS_PROVIDER_IDS = [
  "google-calendar",
  "gmail",
  "github",
  "x",
  "whatsapp",
  "telegram",
  "signal",
  "discord",
  "imessage-bluebubbles",
  "twilio",
  "calendly",
  "eliza-cloud-managed-google",
] as const;

export const LIFEOPS_PROVIDER_MOCK_COVERAGE = [
  {
    id: "google-calendar",
    label: "Google Calendar",
    mode: "stateful-http",
    environment: "google",
    envVars: ["ELIZA_MOCK_GOOGLE_BASE"],
    surfaces: [
      "OAuth token and userinfo rewrite",
      "calendar list",
      "event list/get/search",
      "event create/patch/update/move/delete",
      "request ledger metadata",
    ],
    knownGaps: [
      "No recurring-event expansion beyond single synthetic events",
      "No freebusy, ACL, attachment, or conference-data surfaces",
      "No Google rate-limit or partial-failure variants",
    ],
    validation: [
      "test/mocks/__tests__/google-calendar-mock.test.ts",
      "eliza/apps/app-lifeops/test/helpers/lifeops-deterministic-llm.test.ts",
      "eliza/apps/app-lifeops/test/scenarios/calendar-llm-eval-mutations.scenario.ts",
    ],
  },
  {
    id: "gmail",
    label: "Gmail",
    mode: "stateful-http",
    environment: "google",
    envVars: ["ELIZA_MOCK_GOOGLE_BASE", "ELIZA_BLOCK_REAL_GMAIL_WRITES"],
    surfaces: [
      "work/home account fixture data",
      "message list/get/search/send/modify/delete",
      "thread list/get/modify/trash/untrash",
      "draft create/list/get/send/delete",
      "labels, history, watch, filters",
      "priority, vague, multi-search, and cross-account query fixtures",
      "write request ledger metadata",
    ],
    knownGaps: [
      "Search is deterministic fixture matching, not the full Gmail query grammar",
      "No attachment download/upload or multipart MIME fidelity",
      "No delegated mailbox, push-notification, quota, or rate-limit variants",
    ],
    validation: [
      "test/mocks/__tests__/google-mock-fidelity.test.ts",
      "eliza/apps/app-lifeops/test/helpers/lifeops-deterministic-llm.test.ts",
      "eliza/apps/app-lifeops/test/scenarios/gmail-llm-eval-search-priority.scenario.ts",
    ],
  },
  {
    id: "github",
    label: "GitHub",
    mode: "stateful-http",
    environment: "github",
    envVars: ["ELIZA_MOCK_GITHUB_BASE", "GITHUB_API_URL"],
    surfaces: [
      "REST pull request list/review",
      "issue creation and assignment fixtures",
      "issue/PR search",
      "notification list",
      "Octokit-shaped unit-test fixture",
      "request ledger metadata",
    ],
    knownGaps: [
      "No GraphQL API coverage",
      "No checks, statuses, contents, branch protection, or workflow endpoints",
      "No webhook delivery simulation",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "test/mocks/helpers/github-octokit-fixture.ts",
    ],
  },
  {
    id: "x",
    label: "X",
    mode: "stateful-http",
    environment: "x-twitter",
    envVars: ["ELIZA_MOCK_X_BASE"],
    surfaces: [
      "home timeline",
      "mentions",
      "recent search",
      "DM list",
      "tweet create",
      "DM send",
      "request ledger metadata",
    ],
    knownGaps: [
      "No streaming API, OAuth handshake, media upload, or delete/like/repost surfaces",
      "No rate-limit, partial response, or protected-account variants",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "eliza/apps/app-lifeops/test/lifeops-x-dm-reader.integration.test.ts",
      "eliza/apps/app-lifeops/src/actions/search-across-channels.test.ts",
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp Business Cloud",
    mode: "stateful-http",
    environment: "whatsapp",
    envVars: ["ELIZA_MOCK_WHATSAPP_BASE"],
    surfaces: [
      "text message send",
      "inbound webhook ingestion",
      "test-only inbound buffer route",
      "request ledger metadata",
    ],
    knownGaps: [
      "No media upload/download, templates, reactions, or message status lifecycle",
      "No webhook signature validation or delivery retry simulation",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "eliza/apps/app-lifeops/test/whatsapp.test.ts",
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    mode: "dependency-seam",
    environment: null,
    envVars: [],
    surfaces: [
      "MTProto local-client dependency injection",
      "auth retry state",
      "connector service status",
      "send/search/read-receipt calls through mocked client deps",
    ],
    knownGaps: [
      "No central HTTP mock because LifeOps does not consume Telegram through HTTP",
      "No MTProto protocol simulator, media fixture, or group-admin fixture",
    ],
    rationale:
      "LifeOps uses telegram-local-client.ts and TelegramLocalClientDeps; an HTTP Mockoon facade would test a path the product does not call.",
    validation: [
      "eliza/apps/app-lifeops/src/lifeops/telegram-local-client.test.ts",
      "eliza/apps/app-lifeops/src/lifeops/service-mixin-telegram.test.ts",
      "eliza/apps/app-lifeops/test/cross-channel-send.test.ts",
    ],
  },
  {
    id: "signal",
    label: "Signal",
    mode: "stateful-http",
    environment: "signal",
    envVars: ["SIGNAL_HTTP_URL", "SIGNAL_ACCOUNT_NUMBER"],
    surfaces: [
      "signal-cli health check",
      "REST receive",
      "REST send",
      "JSON-RPC send",
      "request ledger metadata",
    ],
    knownGaps: [
      "No attachment, group-management, profile, registration, or safety-number surfaces",
      "No daemon restart, backfill, or malformed-envelope variants",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "eliza/apps/app-lifeops/test/lifeops-signal-local-client.integration.test.ts",
      "eliza/apps/app-lifeops/src/lifeops/service-mixin-signal.test.ts",
    ],
  },
  {
    id: "discord",
    label: "Discord",
    mode: "browser-workspace",
    environment: "browser-workspace",
    envVars: ["ELIZA_BROWSER_WORKSPACE_URL", "ELIZA_BROWSER_WORKSPACE_TOKEN"],
    surfaces: [
      "desktop browser workspace tab lifecycle",
      "navigation",
      "script evaluation",
      "snapshot",
      "request ledger metadata",
    ],
    knownGaps: [
      "No Discord REST or Gateway mock",
      "DOM fixture cannot prove Discord production layout compatibility",
      "No attachment, reaction, edit, or thread lifecycle coverage",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "eliza/apps/app-lifeops/test/discord-browser-scraper.test.ts",
      "eliza/apps/app-lifeops/test/lifeops-discord-browser-companion.test.ts",
    ],
  },
  {
    id: "imessage-bluebubbles",
    label: "iMessage / BlueBubbles",
    mode: "stateful-http",
    environment: "bluebubbles",
    envVars: [
      "ELIZA_IMESSAGE_BACKEND",
      "ELIZA_BLUEBUBBLES_URL",
      "BLUEBUBBLES_SERVER_URL",
      "ELIZA_BLUEBUBBLES_PASSWORD",
      "BLUEBUBBLES_PASSWORD",
    ],
    surfaces: [
      "server info",
      "chat query",
      "message query/search",
      "text send",
      "message detail/delivery metadata",
      "request ledger metadata",
    ],
    knownGaps: [
      "No attachment, tapback/reaction, edit, unsend, or read-receipt lifecycle",
      "No macOS Messages database fallback fixture in the central mock runner",
    ],
    validation: [
      "test/mocks/__tests__/non-google-provider-mocks.test.ts",
      "eliza/apps/app-lifeops/test/imessage.test.ts",
      "eliza/apps/app-lifeops/src/lifeops/imessage-bridge.test.ts",
    ],
  },
  {
    id: "twilio",
    label: "Twilio",
    mode: "static-http",
    environment: "twilio",
    envVars: ["ELIZA_MOCK_TWILIO_BASE"],
    surfaces: [
      "Programmable Messaging send",
      "Programmable Voice call create",
      "Mockoon template request echo",
    ],
    knownGaps: [
      "No delivery status callbacks, recordings, media, incoming call webhooks, or error variants",
    ],
    validation: [
      "test/mocks/__tests__/mock-runtime.smoke.test.ts",
      "eliza/apps/app-lifeops/test/twilio-sms.test.ts",
      "eliza/apps/app-lifeops/test/twilio-call.test.ts",
    ],
  },
  {
    id: "calendly",
    label: "Calendly",
    mode: "static-http",
    environment: "calendly",
    envVars: ["ELIZA_MOCK_CALENDLY_BASE"],
    surfaces: [
      "current user",
      "event types",
      "available times",
      "scheduling links",
      "scheduled events",
    ],
    knownGaps: [
      "No webhooks, invitee cancellation/reschedule, organization/team scope, or OAuth refresh variants",
    ],
    validation: [
      "test/mocks/__tests__/mock-runtime.smoke.test.ts",
      "eliza/apps/app-lifeops/test/calendly.test.ts",
    ],
  },
  {
    id: "eliza-cloud-managed-google",
    label: "Eliza Cloud managed Google",
    mode: "static-http",
    environment: "cloud-managed",
    envVars: ["ELIZA_CLOUD_BASE_URL"],
    surfaces: ["managed Google status", "managed Google account list"],
    knownGaps: [
      "No managed mutation routes, cloud auth failure matrix, billing limits, or account relink flows",
    ],
    validation: [
      "test/mocks/__tests__/mock-runtime.smoke.test.ts",
      "test/mocks/__tests__/mock-runtime-seeding.test.ts",
    ],
  },
] as const satisfies readonly LifeOpsProviderMockCoverage[];
