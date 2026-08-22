/**
 * Machine-readable manifest and verifier for the managed Cloud provider
 * accounts tracked by the plugin-first integration program (issue #19910).
 * Each entry names a provider account the platform operates, the
 * secret-manager reference names (env vars) that prove it is provisioned,
 * and whether the program currently requires it. OAuth application entries
 * derive their credential sets from the canonical OAuth provider registry so
 * this manifest can never drift from the env vars the runtime actually reads.
 *
 * Verification reports configured/partial/missing/deferred status only —
 * never credential values — so its output is safe for CI logs and issues.
 * The operator CLI lives at scripts/managed-accounts-doctor.mjs
 * (`bun run verify:managed-accounts`).
 */

import { isPlaceholderProviderKey } from "../providers/provider-env";
import { OAUTH_PROVIDERS } from "../services/oauth/provider-registry";

export type ManagedAccountCategory =
  | "foundation"
  | "work_documents"
  | "social_communications"
  | "platform";

export type ManagedAccountRequirement =
  | { kind: "required" }
  | { kind: "optional" }
  | { kind: "deferred"; owner: string; reason: string };

export interface ManagedAccountSpec {
  /** Stable identifier, unique across the manifest. */
  id: string;
  /** Human-readable provider account name. */
  name: string;
  category: ManagedAccountCategory;
  /** Provider console where the account/application is provisioned. */
  console: string;
  /**
   * Alternative complete credential sets (secret-manager reference names).
   * The account counts as configured when every var in any one set is present
   * and non-placeholder. Deferred entries may have zero sets until a consumer
   * ships.
   */
  credentialSets: readonly (readonly string[])[];
  requirement: ManagedAccountRequirement;
}

/**
 * Derive a manifest entry from the OAuth provider registry so credential sets
 * stay identical to what the OAuth routes read at runtime. Secrets-storage
 * providers contribute their secret patterns; env-var providers contribute
 * their envVars/envVarAlternatives. Secret patterns whose credential field the
 * registry marks optional (e.g. a webhook secret) are excluded so a
 * runtime-valid account is never reported partial.
 */
function fromOAuthRegistry(
  registryId: string,
  category: ManagedAccountCategory,
  consoleUrl: string,
  requirement: ManagedAccountRequirement,
): ManagedAccountSpec {
  const provider = OAUTH_PROVIDERS[registryId];
  if (!provider) {
    throw new Error(`ManagedAccounts: unknown OAuth registry provider "${registryId}"`);
  }
  const registrySets: string[][] =
    provider.envVarAlternatives?.map((set) => [...set]) ??
    (provider.envVars.length > 0 ? [[...provider.envVars]] : []);
  const optionalFieldKeys = new Set(
    (provider.credentialFields ?? []).filter((field) => !field.required).map((field) => field.key),
  );
  const secretSet = provider.secretPatterns
    ? Object.entries(provider.secretPatterns)
        .filter(([key, name]) => Boolean(name) && !optionalFieldKeys.has(key))
        .map(([, name]) => name as string)
    : [];
  const credentialSets =
    registrySets.length > 0 ? registrySets : secretSet.length ? [secretSet] : [];
  return {
    id: provider.id,
    name: provider.name,
    category,
    console: consoleUrl,
    credentialSets,
    requirement,
  };
}

const deferred = (owner: string, reason: string): ManagedAccountRequirement => ({
  kind: "deferred",
  owner,
  reason,
});

/**
 * The managed-account program manifest. Requirement policy:
 * - "required": a shipped managed capability breaks without this account.
 * - "optional": a shipped integration lights up when provisioned but the
 *   platform degrades gracefully without it.
 * - "deferred": tracked by the program with an owner and reason; verification
 *   never fails on it until the requirement is promoted.
 */
export const MANAGED_ACCOUNTS: readonly ManagedAccountSpec[] = [
  // Foundation accounts
  fromOAuthRegistry("google", "foundation", "https://console.cloud.google.com", {
    kind: "required",
  }),
  fromOAuthRegistry("microsoft", "foundation", "https://entra.microsoft.com", {
    kind: "optional",
  }),
  {
    id: "plaid",
    name: "Plaid",
    category: "foundation",
    console: "https://dashboard.plaid.com",
    credentialSets: [["PLAID_CLIENT_ID", "PLAID_SECRET"]],
    requirement: { kind: "optional" },
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "foundation",
    console: "https://www.firecrawl.dev",
    credentialSets: [["FIRECRAWL_API_KEY"]],
    requirement: { kind: "optional" },
  },
  {
    id: "spotify",
    name: "Spotify",
    category: "foundation",
    console: "https://developer.spotify.com/dashboard",
    credentialSets: [],
    requirement: deferred(
      "cloud-integrations",
      "No shipped Cloud consumer reads Spotify OAuth application credentials yet.",
    ),
  },

  // Work and documents
  fromOAuthRegistry("github", "work_documents", "https://github.com/settings/developers", {
    kind: "optional",
  }),
  fromOAuthRegistry("linear", "work_documents", "https://linear.app/settings/api/applications", {
    kind: "optional",
  }),
  fromOAuthRegistry("notion", "work_documents", "https://www.notion.so/my-integrations", {
    kind: "optional",
  }),
  fromOAuthRegistry("dropbox", "work_documents", "https://www.dropbox.com/developers/apps", {
    kind: "optional",
  }),
  fromOAuthRegistry("slack", "work_documents", "https://api.slack.com/apps", {
    kind: "optional",
  }),
  fromOAuthRegistry("jira", "work_documents", "https://developer.atlassian.com/console", {
    kind: "optional",
  }),
  fromOAuthRegistry("hubspot", "work_documents", "https://developers.hubspot.com", {
    kind: "optional",
  }),
  fromOAuthRegistry("asana", "work_documents", "https://app.asana.com/0/developer-console", {
    kind: "optional",
  }),
  fromOAuthRegistry("airtable", "work_documents", "https://airtable.com/create/oauth", {
    kind: "optional",
  }),
  fromOAuthRegistry("salesforce", "work_documents", "https://developer.salesforce.com", {
    kind: "optional",
  }),
  fromOAuthRegistry("zoom", "work_documents", "https://marketplace.zoom.us", {
    kind: "optional",
  }),
  {
    id: "canva",
    name: "Canva",
    category: "work_documents",
    console: "https://www.canva.com/developers",
    credentialSets: [],
    requirement: deferred(
      "cloud-integrations",
      "Canva developer application eligibility is pending; no shipped Cloud consumer yet.",
    ),
  },
  {
    id: "figma",
    name: "Figma",
    category: "work_documents",
    console: "https://www.figma.com/developers/apps",
    credentialSets: [],
    requirement: deferred(
      "cloud-integrations",
      "Figma remote-client catalog eligibility is pending; desktop-local mode ships without a managed account.",
    ),
  },

  // Social and communications
  fromOAuthRegistry("linkedin", "social_communications", "https://developer.linkedin.com", {
    kind: "optional",
  }),
  fromOAuthRegistry("twitter", "social_communications", "https://developer.x.com", {
    kind: "optional",
  }),
  fromOAuthRegistry("twilio", "social_communications", "https://console.twilio.com", {
    kind: "optional",
  }),
  fromOAuthRegistry("blooio", "social_communications", "https://blooio.com", {
    kind: "optional",
  }),
  {
    id: "telegram",
    name: "Telegram",
    category: "social_communications",
    console: "https://t.me/BotFather",
    credentialSets: [
      ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
      ["ELIZA_APP_TELEGRAM_BOT_TOKEN", "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET"],
    ],
    requirement: { kind: "required" },
  },
  {
    id: "discord",
    name: "Discord",
    category: "social_communications",
    console: "https://discord.com/developers/applications",
    credentialSets: [
      ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"],
      [
        "ELIZA_APP_DISCORD_APPLICATION_ID",
        "ELIZA_APP_DISCORD_CLIENT_SECRET",
        "ELIZA_APP_DISCORD_BOT_TOKEN",
      ],
    ],
    requirement: { kind: "required" },
  },
  {
    id: "tiktok",
    name: "TikTok",
    category: "social_communications",
    console: "https://developers.tiktok.com",
    credentialSets: [["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]],
    requirement: { kind: "optional" },
  },
  {
    id: "reddit",
    name: "Reddit",
    category: "social_communications",
    console: "https://www.reddit.com/prefs/apps",
    credentialSets: [],
    requirement: deferred(
      "cloud-integrations",
      "No shipped Cloud consumer reads a managed Reddit application credential yet.",
    ),
  },
  {
    id: "apple-google-native",
    name: "Apple Developer / Google Play",
    category: "platform",
    console: "https://developer.apple.com / https://play.google.com/console",
    credentialSets: [],
    requirement: deferred(
      "cloud-integrations",
      "Native device store accounts are provisioned through the app release pipeline, not Cloud env secrets.",
    ),
  },
];

export type ManagedAccountState = "configured" | "partial" | "missing" | "deferred";

export interface ManagedAccountReport {
  id: string;
  name: string;
  category: ManagedAccountCategory;
  requirement: ManagedAccountRequirement;
  state: ManagedAccountState;
  /** Smallest actionable set of missing secret reference names (never values). */
  missingEnvVars: string[];
}

export interface ManagedAccountsVerification {
  reports: ManagedAccountReport[];
  /** Required accounts that are not fully configured; non-empty means fail closed. */
  requiredMissing: ManagedAccountReport[];
}

function isConfiguredValue(env: Record<string, string | undefined>, name: string): boolean {
  return !isPlaceholderProviderKey(env[name]);
}

/**
 * Evaluate one account against an env snapshot. Alternatives resolve like the
 * OAuth registry: any one complete set means configured, and the reported
 * missing list is the smallest remaining set. Placeholder values never count.
 */
export function evaluateManagedAccount(
  spec: ManagedAccountSpec,
  env: Record<string, string | undefined>,
): ManagedAccountReport {
  const base = {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    requirement: spec.requirement,
  };

  if (spec.credentialSets.length === 0) {
    return { ...base, state: "deferred", missingEnvVars: [] };
  }

  const missingPerSet = spec.credentialSets.map((set) =>
    set.filter((name) => !isConfiguredValue(env, name)),
  );
  const bestIndex = missingPerSet
    .map((missing, index) => ({ missing, index }))
    .sort((a, b) => a.missing.length - b.missing.length)[0].index;
  const missingEnvVars = missingPerSet[bestIndex];

  if (missingEnvVars.length === 0) {
    return { ...base, state: "configured", missingEnvVars: [] };
  }
  if (spec.requirement.kind === "deferred") {
    return { ...base, state: "deferred", missingEnvVars };
  }
  const anyPresent = missingEnvVars.length < spec.credentialSets[bestIndex].length;
  return { ...base, state: anyPresent ? "partial" : "missing", missingEnvVars };
}

/** Evaluate the whole manifest against an env snapshot. */
export function verifyManagedAccounts(
  env: Record<string, string | undefined>,
  accounts: readonly ManagedAccountSpec[] = MANAGED_ACCOUNTS,
): ManagedAccountsVerification {
  const reports = accounts.map((spec) => evaluateManagedAccount(spec, env));
  const requiredMissing = reports.filter(
    (report) => report.requirement.kind === "required" && report.state !== "configured",
  );
  return { reports, requiredMissing };
}
