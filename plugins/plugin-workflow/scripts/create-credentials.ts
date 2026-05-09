#!/usr/bin/env npx ts-node
/**
 * Create n8n credentials for trigger schema capture.
 *
 * Auto-discovers OAuth2 credential types needed by trigger nodes from
 * defaultNodes.json, creates them on n8n cloud, and persists the returned
 * credential IDs to .credentials-map.json.
 *
 * If OAuth client ID/secret env vars are available (e.g. from .env.vercel),
 * the script uses them. Otherwise falls back to empty values (n8n cloud
 * provides its own defaults — just click "Connect" in the UI).
 *
 * After running, go to the n8n UI and click "Connect" on each credential.
 *
 * Usage:
 *   WORKFLOW_HOST=https://... WORKFLOW_API_KEY=xxx bun run scripts/create-credentials.ts
 *
 * Flags:
 *   --list        List credentials from local .credentials-map.json
 *   --delete-all  Delete all credentials from n8n + local map
 *   --dry-run     Show what would be created without creating
 *   --filter=xxx  Only create credentials matching this name
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKFLOW_HOST = process.env.WORKFLOW_HOST;
const WORKFLOW_API_KEY = process.env.WORKFLOW_API_KEY;

// ─── Local credentials map (.credentials-map.json) ──────────────────────────
// n8n cloud doesn't support GET /credentials, so we persist IDs locally.

const CRED_MAP_PATH = path.join(__dirname, "..", ".credentials-map.json");

interface CredMapEntry {
  id: string;
  name: string;
  createdAt: string;
}

function loadCredentialsMap(): Record<string, CredMapEntry> {
  if (!fs.existsSync(CRED_MAP_PATH)) return {};
  return JSON.parse(fs.readFileSync(CRED_MAP_PATH, "utf-8"));
}

function saveCredentialsMap(map: Record<string, CredMapEntry>): void {
  fs.writeFileSync(CRED_MAP_PATH, JSON.stringify(map, null, 2) + "\n");
}

// ─── n8n API helpers ─────────────────────────────────────────────────────────

async function n8nRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  if (!WORKFLOW_HOST || !WORKFLOW_API_KEY) {
    throw new Error("Missing WORKFLOW_HOST or WORKFLOW_API_KEY environment variables");
  }
  const url = `${WORKFLOW_HOST}/api/v1${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": WORKFLOW_API_KEY,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  if (response.status === 204) return undefined as unknown as T;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `n8n API ${method} ${endpoint}: ${response.status} ${text}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : (undefined as unknown as T);
}

interface WorkflowCredential {
  id: string;
  name: string;
  type: string;
}

async function deleteCredential(id: string): Promise<void> {
  await n8nRequest("DELETE", `/credentials/${id}`);
}

// ─── Supported platforms (mirrors eliza-cloud-v2 oauth-cred-map.ts) ─────────
// Only create credentials for platforms that eliza-cloud supports.

const SUPPORTED_PREFIXES: Record<string, string[]> = {
  google: ["gmail", "google", "gSuite", "youTube"],
  microsoft: ["microsoft"],
  slack: ["slack"],
  github: ["github"],
  linear: ["linear"],
  notion: ["notion"],
  twitter: ["twitter"],
  asana: ["asana"],
  salesforce: ["salesforce"],
  airtable: ["airtable"],
  jira: ["jira"],
  dropbox: ["dropbox"],
  zoom: ["zoom"],
  linkedin: ["linkedin"],
};

const PREFIX_LIST = Object.values(SUPPORTED_PREFIXES).flat();

function isSupportedCredType(credType: string): boolean {
  return PREFIX_LIST.some((prefix) => credType.startsWith(prefix));
}

// ─── Env var mapping: n8n cred type prefix → env var prefix ─────────────────
// Maps platform keys to the env var names used in eliza-cloud-v2 (Vercel).

const PLATFORM_ENV_MAP: Record<
  string,
  { clientId: string; clientSecret: string; extra?: Record<string, string> }
> = {
  google: {
    clientId: "GOOGLE_CLIENT_ID",
    clientSecret: "GOOGLE_CLIENT_SECRET",
  },
  microsoft: {
    clientId: "MICROSOFT_CLIENT_ID",
    clientSecret: "MICROSOFT_CLIENT_SECRET",
  },
  slack: { clientId: "SLACK_CLIENT_ID", clientSecret: "SLACK_CLIENT_SECRET" },
  github: {
    clientId: "GITHUB_CLIENT_ID",
    clientSecret: "GITHUB_CLIENT_SECRET",
  },
  linear: {
    clientId: "LINEAR_CLIENT_ID",
    clientSecret: "LINEAR_CLIENT_SECRET",
  },
  notion: {
    clientId: "NOTION_CLIENT_ID",
    clientSecret: "NOTION_CLIENT_SECRET",
  },
  twitter: {
    clientId: "TWITTER_CLIENT_ID",
    clientSecret: "TWITTER_CLIENT_SECRET",
  },
  asana: { clientId: "ASANA_CLIENT_ID", clientSecret: "ASANA_CLIENT_SECRET" },
  salesforce: {
    clientId: "SALESFORCE_CLIENT_ID",
    clientSecret: "SALESFORCE_CLIENT_SECRET",
  },
  airtable: {
    clientId: "AIRTABLE_CLIENT_ID",
    clientSecret: "AIRTABLE_CLIENT_SECRET",
  },
  jira: { clientId: "JIRA_CLIENT_ID", clientSecret: "JIRA_CLIENT_SECRET" },
  dropbox: {
    clientId: "DROPBOX_CLIENT_ID",
    clientSecret: "DROPBOX_CLIENT_SECRET",
  },
  zoom: { clientId: "ZOOM_CLIENT_ID", clientSecret: "ZOOM_CLIENT_SECRET" },
  linkedin: {
    clientId: "LINKEDIN_CLIENT_ID",
    clientSecret: "LINKEDIN_CLIENT_SECRET",
  },
};

/** Find the platform key for a credential type (e.g. "googleOAuth2Api" → "google") */
function findPlatform(credType: string): string | undefined {
  for (const [platform, prefixes] of Object.entries(SUPPORTED_PREFIXES)) {
    if (prefixes.some((prefix) => credType.startsWith(prefix))) {
      return platform;
    }
  }
  return undefined;
}

/** Resolve OAuth client ID/secret from env vars if available */
function resolveOAuthData(credType: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    clientId: "",
    clientSecret: "",
    serverUrl: "",
    sendAdditionalBodyProperties: false,
    additionalBodyProperties: "",
  };

  const platform = findPlatform(credType);
  if (platform && PLATFORM_ENV_MAP[platform]) {
    const envMap = PLATFORM_ENV_MAP[platform];
    const clientId = process.env[envMap.clientId];
    const clientSecret = process.env[envMap.clientSecret];
    if (clientId) data.clientId = clientId;
    if (clientSecret) data.clientSecret = clientSecret;
    // Extra fields (e.g. Microsoft tenantId)
    if (envMap.extra) {
      for (const [field, envVar] of Object.entries(envMap.extra)) {
        const val = process.env[envVar];
        if (val) data[field] = val;
      }
    }
  }

  // Some credential types require extra fields
  if (credType.startsWith("microsoftOutlook")) {
    data.userPrincipalName = "";
  }

  return data;
}

// ─── Trigger credential discovery from defaultNodes.json ────────────────────

interface NodeDef {
  name: string;
  displayName: string;
  group: string[];
  credentials?: Array<{ name: string; required: boolean }>;
}

function discoverOAuth2CredTypes(): string[] {
  const catalogPath = path.join(__dirname, "../src/data/defaultNodes.json");
  const nodes: NodeDef[] = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));

  const triggers = nodes.filter((n) => n.group?.includes("trigger"));
  const oauth2 = new Set<string>();

  for (const trigger of triggers) {
    for (const cred of trigger.credentials || []) {
      if (!cred.name.toLowerCase().includes("oauth2")) continue;
      if (!isSupportedCredType(cred.name)) continue;
      oauth2.add(cred.name);
    }
  }

  return [...oauth2].sort();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const credMap = loadCredentialsMap();

  // --list mode
  if (args.includes("--list")) {
    const entries = Object.entries(credMap);
    if (entries.length === 0) {
      console.log(
        "No credentials in .credentials-map.json. Run without --list to create some.",
      );
      return;
    }
    console.log(`${entries.length} credentials in .credentials-map.json:\n`);
    for (const [credType, entry] of entries) {
      console.log(`  [${entry.id}] ${credType} — "${entry.name}"`);
    }
    return;
  }

  // --delete-all mode
  if (args.includes("--delete-all")) {
    if (!WORKFLOW_HOST || !WORKFLOW_API_KEY) {
      console.error("Missing WORKFLOW_HOST or WORKFLOW_API_KEY environment variables");
      process.exit(1);
    }
    const entries = Object.entries(credMap);
    if (entries.length === 0) {
      console.log("No credentials to delete.");
      return;
    }
    console.log(`Deleting ${entries.length} credentials...`);
    for (const [credType, entry] of entries) {
      try {
        await deleteCredential(entry.id);
        delete credMap[credType];
        console.log(`  Deleted: ${credType} — "${entry.name}" (${entry.id})`);
      } catch (error) {
        console.log(
          `  FAIL: ${credType} (${entry.id}) — ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    saveCredentialsMap(credMap);
    return;
  }

  if (!WORKFLOW_HOST || !WORKFLOW_API_KEY) {
    console.error("Missing WORKFLOW_HOST or WORKFLOW_API_KEY environment variables");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];

  // Discover OAuth2 credential types from trigger nodes
  let credTypes = discoverOAuth2CredTypes();
  if (filter) {
    credTypes = credTypes.filter((ct) =>
      ct.toLowerCase().includes(filter.toLowerCase()),
    );
  }
  console.log(
    `Discovered ${credTypes.length} OAuth2 credential types from trigger nodes\n`,
  );

  console.log(
    `Creating credentials on ${WORKFLOW_HOST} (using n8n cloud defaults)...\n`,
  );

  const needsConnect: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const credType of credTypes) {
    // Skip if already in local map
    if (credMap[credType]) {
      const existing = credMap[credType];
      console.log(`  SKIP  ${credType} — already created (${existing.id})`);
      skipped++;
      continue;
    }

    const displayName = `[Auto] ${credType}`;

    if (dryRun) {
      console.log(`  WOULD ${credType}`);
      created++;
      continue;
    }

    try {
      const data = resolveOAuthData(credType);
      const result = await n8nRequest<WorkflowCredential>("POST", "/credentials", {
        name: displayName,
        type: credType,
        data,
      });

      credMap[credType] = {
        id: result.id,
        name: displayName,
        createdAt: new Date().toISOString(),
      };
      saveCredentialsMap(credMap);

      const hasEnvCreds = data.clientId && data.clientSecret;
      console.log(
        `  OK    ${credType} (${result.id})${hasEnvCreds ? " — with env credentials" : " — n8n defaults"}`,
      );
      needsConnect.push(`  ${credType} → ${WORKFLOW_HOST}/credentials/${result.id}`);
      created++;
    } catch (error) {
      console.log(
        `  FAIL  ${credType} — ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (dryRun) {
    console.log(
      `\n${created} credentials would be created. Run without --dry-run to create.`,
    );
    return;
  }

  // Summary
  console.log(`\nCreated: ${created} | Skipped: ${skipped}`);

  if (needsConnect.length > 0) {
    console.log('\n── Go to n8n UI and click "Connect" on each: ──\n');
    for (const url of needsConnect) {
      console.log(url);
    }
  }

  const allEntries = Object.entries(credMap);
  console.log(`\n── Credentials map (${allEntries.length} total) ──`);
  for (const [credType, entry] of allEntries) {
    console.log(`  [${entry.id}] ${credType}`);
  }
  console.log(`\nSaved to ${CRED_MAP_PATH}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
