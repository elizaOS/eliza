/**
 * First-party registry aggregator — the build-time generator behind the
 * `generate:first-party` script.
 *
 * Registration is plugin-side: each in-repo plugin/package owns its registry
 * entry as a `registry-entry.json` in its own directory (a single entry object,
 * or an array of entries). Curated entries with no vendored package — built-in
 * app-viewers and entries for plugins not checked out in this repo — live under
 * `curated/`. This script gathers all of them, validates each fail-loud against
 * the Zod schema, dedupes by id, and writes the aggregated `generated.json` that
 * the runtime loader reads (a single committed artifact, trivial to stage
 * alongside an on-device bundle), plus the derived curated-app / channel /
 * provider maps. `--check` re-runs the generator and fails on drift for CI.
 *
 *   bun run --cwd packages/registry generate:first-party           # rewrite generated.json
 *   bun run --cwd packages/registry generate:first-party --check   # CI drift gate
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RegistryEntry, registryEntrySchema } from "./schema";

// Resolve biome from the repo-root package.json, not this file: this package
// doesn't declare @biomejs/biome, so under isolated installs resolving from
// here walks up PAST the repo into whatever stale copy a parent workspace
// hoisted — version-skewed against biome.json's pinned schema.
const rootRequire = createRequire(
  new URL("../../../../package.json", import.meta.url),
);

// `JSON.stringify(…, null, 2)` puts every array element on its own line, but
// biome — the repo's format gate (`bun run format:check`) — collapses arrays
// that fit onto a single line. Without reconciling the two, the committed
// artifacts can only satisfy one gate at a time, and a later `registry build`
// (which re-runs this generator) silently re-breaks the biome gate. Piping each
// artifact through biome makes the generator emit exactly what `format:check`
// expects, so generator output, committed files, and the format gate all agree.
function biomeFormatJson(content: string, filePath: string): string {
  const biomeBin = rootRequire.resolve("@biomejs/biome/bin/biome");
  return execFileSync(
    process.execPath,
    [biomeBin, "format", `--stdin-file-path=${filePath}`],
    { input: content, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CURATED_DIR = join(HERE, "curated");
const GENERATED_PATH = join(HERE, "generated.json");
// Small derived artifact: just the curated-app definitions (slug, canonicalName,
// aliases), ordered. `@elizaos/shared` statically imports this (browser-safe, no
// fs) to materialize ELIZA_CURATED_APP_DEFINITIONS without bundling the full
// registry. Regenerated alongside generated.json.
const CURATED_DEFS_PATH = join(HERE, "curated-app-definitions.json");
// Derived channel -> plugin-package map. agent + app-core statically import this
// (browser-safe, no fs) instead of hand-maintaining duplicate CHANNEL_PLUGIN_MAPs.
const CHANNEL_MAP_PATH = join(HERE, "channel-plugin-map.json");
// Derived env-key -> provider plugin package map. The agent statically imports
// this instead of hand-maintaining PROVIDER_PLUGIN_MAP. Entries opt in by
// marking config fields with `autoEnableProvider: true`.
const PROVIDER_MAP_PATH = join(HERE, "provider-plugin-map.json");
// Derived short-id -> plugin-package map. The agent statically imports this to
// build OPTIONAL_PLUGIN_MAP instead of hand-maintaining the alias table. Entries
// opt in by listing bare ids in `shortIds` (e.g. evm/solana/wallet -> wallet).
const SHORTID_MAP_PATH = join(HERE, "short-id-plugin-map.json");
// Generated connector truth inventory (#24373): one row per bundled channel
// claim, derived from the plugin's real MessageConnector registrations in
// source. Committed and drift-gated like the other artifacts so registry
// claims cannot outrun first-party code.
const TRUTH_INVENTORY_PATH = join(HERE, "connector-truth-inventory.json");

interface CuratedAppDefinition {
  slug: string;
  canonicalName: string;
  aliases: string[];
}

export function collectCuratedAppDefinitions(
  entries: RegistryEntry[],
): CuratedAppDefinition[] {
  return entries
    .filter((e) => Boolean(e.curatedApp))
    .sort((a, b) => {
      const aOrder =
        typeof a.curatedApp?.order === "number" &&
        Number.isFinite(a.curatedApp.order)
          ? a.curatedApp.order
          : 0;
      const bOrder =
        typeof b.curatedApp?.order === "number" &&
        Number.isFinite(b.curatedApp.order)
          ? b.curatedApp.order
          : 0;
      return (
        aOrder - bOrder ||
        (a.curatedApp?.slug ?? "").localeCompare(b.curatedApp?.slug ?? "")
      );
    })
    .map((e) => ({
      slug: e.curatedApp?.slug ?? "",
      // canonicalName is the entry's npm package; every curated entry declares one.
      canonicalName: e.npmName ?? "",
      aliases: e.curatedApp?.aliases ?? [],
    }));
}

// Derive the channel -> plugin-package map from connector entries' `channels`.
// This replaces the hand-maintained CHANNEL_PLUGIN_MAP duplicated in agent +
// app-core. Keys are sorted for a stable artifact; consumers read by key.
export function collectChannelPluginMap(
  entries: RegistryEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (!e.npmName) continue;
    for (const channel of e.channels ?? []) {
      if (map[channel] && map[channel] !== e.npmName) {
        throw new Error(
          `[registry/generate] channel "${channel}" claimed by both ${map[channel]} and ${e.npmName}`,
        );
      }
      map[channel] = e.npmName;
    }
  }
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]]),
  );
}

// Derive the short-id -> plugin-package map from entries' `shortIds`. This
// replaces the hand-maintained OPTIONAL_PLUGIN_MAP alias table for entries that
// declare a registry entry. Keys are sorted for a stable artifact. Conflicting
// claims fail loudly at generation time so drift cannot silently ship — the
// same guarantee CHANNEL_PLUGIN_MAP gives channel aliases.
export function collectShortIdPluginMap(
  entries: RegistryEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (!e.npmName) continue;
    for (const shortId of e.shortIds ?? []) {
      if (map[shortId] && map[shortId] !== e.npmName) {
        throw new Error(
          `[registry/generate] short id "${shortId}" claimed by both ${map[shortId]} and ${e.npmName}`,
        );
      }
      map[shortId] = e.npmName;
    }
  }
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]]),
  );
}

export function collectProviderPluginMap(
  entries: RegistryEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (!e.npmName) continue;
    for (const [envKey, field] of Object.entries(e.config ?? {})) {
      if (field.autoEnableProvider !== true) continue;
      if (map[envKey] && map[envKey] !== e.npmName) {
        throw new Error(
          `[registry/generate] provider env key "${envKey}" claimed by both ${map[envKey]} and ${e.npmName}`,
        );
      }
      map[envKey] = e.npmName;
    }
  }
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]]),
  );
}

// ---------------------------------------------------------------------------
// Connector truth inventory (#24373)
// ---------------------------------------------------------------------------

/**
 * Extract the balanced object literal that starts at `file[openIdx] === "{"`.
 * Returns the inner text between the outer braces.
 */
function balancedObjectAt(file: string, openIdx: number): string | null {
  if (file[openIdx] !== "{") return null;
  let depth = 0;
  for (let i = openIdx; i < file.length && i < openIdx + 20000; i++) {
    const ch = file[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return file.slice(openIdx + 1, i);
    }
  }
  return null;
}

function literalsIn(text: string): string[] {
  const out: string[] = [];
  const re = /"([a-zA-Z0-9_.-]+)"|'([a-zA-Z0-9_.-]+)'/g;
  for (const m of text.matchAll(re)) {
    out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

/**
 * Extract string-literal elements of the array assigned to `key:` inside an
 * extracted registration body, UNIONED across conditional (ternary) branches —
 * the inventory's claim is the aggregate of what the site may declare, so a
 * transport-conditional registration must not silently drop one branch's
 * capabilities. Resolves the `[...CONST]` spread form against the constant's
 * literal array declaration in the same file.
 */
function literalArrayFor(file: string, body: string, key: string): string[] {
  const keyIdx = body.indexOf(`${key}:`);
  if (keyIdx === -1) return [];
  const out = new Set<string>();
  let cursor = body.indexOf("[", keyIdx);
  let sawArray = false;
  // Continue past `? [..] : [..]` ternary alternates only: after a balanced
  // array, the next non-space token must be `:` (a new property key starts
  // with an identifier, not a colon, so sibling properties cannot chain in).
  while (cursor !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = cursor; i < body.length; i++) {
      const ch = body[i];
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    sawArray = true;
    const inner = body.slice(cursor + 1, end).trim();
    if (inner.length > 0) {
      const spread = inner.match(/^\.\.\.([A-Z][A-Z0-9_]*)$/);
      if (spread) {
        const constName = spread[1] as string;
        const decl = file.match(
          new RegExp(
            `(?:const|let) ${constName}\\s*[=:]\\s*\\[([\\s\\S]*?)\\]`,
          ),
        );
        if (!decl) {
          throw new Error(
            `[registry/generate] connector truth inventory: cannot resolve array constant ${constName} — extend the extractor or inline the literal`,
          );
        }
        for (const lit of literalsIn(decl[1] ?? "")) out.add(lit);
      } else {
        for (const lit of literalsIn(inner)) out.add(lit);
      }
    }
    if (!/^\s*:/.test(body.slice(end + 1))) break;
    cursor = body.indexOf("[", end + 1);
  }
  if (!sawArray) return [];
  return [...out].sort();
}

/** Registration `source:` values: literals directly, known constants by map. */
const KNOWN_SOURCE_CONSTANTS: Record<string, string> = {
  MATRIX_SERVICE_NAME: "matrix",
  IMESSAGE_SERVICE_NAME: "imessage",
  GOOGLE_CHAT_SERVICE_NAME: "google-chat",
  GMAIL_MESSAGE_SOURCE: "gmail",
  GOOGLE_SERVICE_NAME: "google",
};

function registrationSourcesOf(body: string): string[] {
  const out = new Set<string>();
  const re = /source:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Z][A-Z0-9_]*))/g;
  for (const m of body.matchAll(re)) {
    const literal = m[1] ?? m[2];
    if (literal) {
      out.add(literal);
      continue;
    }
    const ident = m[3] as string;
    const resolved = KNOWN_SOURCE_CONSTANTS[ident];
    if (!resolved) {
      throw new Error(
        `[registry/generate] connector truth inventory: unknown source constant ${ident} — add it to KNOWN_SOURCE_CONSTANTS so the inventory stays complete`,
      );
    }
    out.add(resolved);
  }
  return [...out].sort();
}

interface ExtractedRegistration {
  site: string;
  sources: string[];
  capabilities: string[];
  supportedTargetKinds: string[];
}

function extractFromFile(
  fileText: string,
  repoRel: string,
): ExtractedRegistration[] {
  const out: ExtractedRegistration[] = [];
  const bodies = new Set<string>();

  const pushBody = (body: string): void => {
    if (bodies.has(body)) return;
    bodies.add(body);
    out.push({
      site: repoRel,
      sources: registrationSourcesOf(body),
      capabilities: literalArrayFor(fileText, body, "capabilities"),
      supportedTargetKinds: literalArrayFor(
        fileText,
        body,
        "supportedTargetKinds",
      ),
    });
  };

  // Shape-based detection (#24373): production registrations are constructed in
  // many shapes — inline call arguments, typed const assignments, factory
  // returns, and helper-parameter indirection (the object literal lives away
  // from the registerMessageConnector call). Chasing call graphs duplicates the
  // compiler; instead detect registration-SHAPED object literals directly: any
  // balanced object declaring `source:`, `capabilities:`, and
  // `supportedTargetKinds:` is a MessageConnectorRegistration literal. False
  // positives would need all three keys by accident.
  for (let i = 0; i < fileText.length; i++) {
    if (fileText[i] !== "{") continue;
    const probe = fileText.slice(i, i + 200);
    if (!probe.includes("source:")) continue;
    const body = balancedObjectAt(fileText, i);
    if (!body) continue;
    if (
      !body.includes("capabilities:") ||
      !body.includes("supportedTargetKinds:")
    )
      continue;
    pushBody(body);
  }

  return out;
}

function scanRegistrationSites(pluginDir: string): ExtractedRegistration[] {
  const sites: ExtractedRegistration[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (
        dirent.name === "node_modules" ||
        dirent.name === "dist" ||
        dirent.name === "__tests__" ||
        dirent.name === "test" ||
        dirent.name.startsWith("test.") ||
        dirent.name.includes(".test.")
      )
        continue;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/[.](?:[cm]?[jt]sx?)$/.test(dirent.name)) continue;
      const file = readFileSync(full, "utf8");
      sites.push(...extractFromFile(file, pathRelativeToRepoRoot(full)));
    }
  };
  walk(pluginDir);
  return sites.sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * Repository-relative site-path conversion. `relative` + separator
 * normalization keeps emitted site paths repository-relative on every
 * platform: a literal `${REPO_ROOT}/` replace never matches Windows
 * `\`-joined paths and would commit machine-specific absolute paths into
 * connector-truth-inventory.json. The path-module and root parameters exist
 * so the regression test can pin Windows (`path.win32`) semantics on any
 * host lane against THIS production function.
 */
export function pathRelativeToRepoRoot(
  file: string,
  pathModule: typeof path = path,
  root: string = REPO_ROOT,
): string {
  return pathModule.relative(root, file).split(pathModule.sep).join("/");
}

/** Target kinds that imply group-scope conversation surfaces. */
const MEMBERSHIP_TARGET_KINDS = ["room", "channel", "thread", "group"] as const;

/** Capabilities that only make sense for an outbound send path. */
const SEND_ONLY_CAPABILITIES = new Set([
  "send_message",
  "send_thread_reply",
  "send_attachment",
  "send_reaction",
  "react_to_message",
  "send_formatted_message",
  "resolve_targets",
  "contact_resolution",
]);

type ConnectorMembership = "send-only" | "group-scope" | "direct-scope";

/**
 * Derive the connector's conversation scope from its unioned registration
 * literals. Documented rule (kept mechanical so the inventory cannot editorialize):
 * - "send-only"  — every declared capability is an outbound-send or
 *                  target-resolution capability (Gmail: ["send_message"]).
 * - "group-scope" — at least one group-scope target kind (room/channel/thread/
 *                  group) is addressable (Discord, Slack, Telegram, ...).
 * - "direct-scope" — otherwise (X DMs: user/contact targets only).
 */
function membershipScope(
  capabilities: string[],
  supportedTargetKinds: string[],
): ConnectorMembership {
  const hasNonSend =
    capabilities.filter((c) => !SEND_ONLY_CAPABILITIES.has(c)).length > 0;
  if (capabilities.length > 0 && !hasNonSend) return "send-only";
  const hasGroupKind = supportedTargetKinds.some((kind) =>
    (MEMBERSHIP_TARGET_KINDS as readonly string[]).includes(kind),
  );
  return hasGroupKind ? "group-scope" : "direct-scope";
}

type ConnectorTruthRow = {
  plugin: string;
  packageName: string;
  channels: string[];
  registrationSites: string[];
  /** Per-registration-source truth: each source's own capabilities, target kinds, and scope. */
  registrations: Array<{
    source: string;
    capabilities: string[];
    supportedTargetKinds: string[];
    scope: ConnectorMembership;
    sites: string[];
  }>;
  /** Union across registrations — convenience for consumers listing one scope per plugin. */
  capabilities: string[];
  supportedTargetKinds: string[];
  scope: ConnectorMembership;
};

/**
 * Build the connector truth inventory (#24373): one row per bundled entry that
 * claims channels, derived from that entry's own plugin source. A channel claim
 * without a production registration fails loud, and every registration source
 * constant must be resolvable — the inventory cannot silently rot.
 */
export function collectConnectorTruthInventory(
  entries: RegistryEntry[],
): ConnectorTruthRow[] {
  const rows: ConnectorTruthRow[] = [];
  for (const entry of entries) {
    if ((entry.channels?.length ?? 0) === 0) continue;
    if (entry.source === "store") continue; // unreachable after the schema ratchet
    const packageName = entry.npmName;
    if (!packageName) {
      throw new Error(
        `[registry/generate] connector truth inventory: entry ${entry.id} claims channels without an npmName`,
      );
    }
    const pluginDir = join(
      REPO_ROOT,
      "plugins",
      packageName.replace("@elizaos/", ""),
    );
    if (!existsSync(pluginDir)) {
      throw new Error(
        `[registry/generate] connector truth inventory: ${entry.id} claims channels but has no first-party plugin directory at ${pathRelativeToRepoRoot(pluginDir)} (#24373)`,
      );
    }
    const sites = scanRegistrationSites(pluginDir);
    const registrations = sites.filter((s) => s.sources.length > 0);
    if (registrations.length === 0) {
      throw new Error(
        `[registry/generate] connector truth inventory: ${entry.id} claims channels [${entry.channels.join(", ")}] but plugin ${packageName} has no resolvable MessageConnector registration (#24373)`,
      );
    }
    const bySource = new Map<
      string,
      { capabilities: Set<string>; kinds: Set<string>; sites: Set<string> }
    >();
    for (const reg of registrations) {
      for (const source of reg.sources) {
        let bucket = bySource.get(source);
        if (!bucket) {
          bucket = {
            capabilities: new Set(),
            kinds: new Set(),
            sites: new Set(),
          };
          bySource.set(source, bucket);
        }
        for (const c of reg.capabilities) bucket.capabilities.add(c);
        for (const k of reg.supportedTargetKinds) bucket.kinds.add(k);
        bucket.sites.add(reg.site);
      }
    }
    const sourceRows = [...bySource.entries()]
      .map(([source, bucket]) => ({
        source,
        capabilities: [...bucket.capabilities].sort(),
        supportedTargetKinds: [...bucket.kinds].sort(),
        scope: membershipScope([...bucket.capabilities], [...bucket.kinds]),
        sites: [...bucket.sites].sort(),
      }))
      .sort((a, b) => a.source.localeCompare(b.source));
    const capabilities = [
      ...new Set(sourceRows.flatMap((s) => s.capabilities)),
    ].sort();
    const supportedTargetKinds = [
      ...new Set(sourceRows.flatMap((s) => s.supportedTargetKinds)),
    ].sort();
    rows.push({
      plugin: packageName.replace("@elizaos/", ""),
      packageName,
      channels: [...entry.channels].sort(),
      registrationSites: [...new Set(registrations.map((s) => s.site))].sort(),
      registrations: sourceRows,
      capabilities,
      supportedTargetKinds,
      scope: membershipScope(capabilities, supportedTargetKinds),
    });
  }
  return rows.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

interface SourcedEntry {
  entry: RegistryEntry;
  file: string;
}

function readEntryFile(file: string): SourcedEntry[] {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.map((data) => {
    const parsed = registryEntrySchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `[registry/generate] ${file} failed validation: ${String(parsed.error)}`,
      );
    }
    return { entry: parsed.data, file };
  });
}

function collectPluginOwnedEntries(): SourcedEntry[] {
  const out: SourcedEntry[] = [];
  for (const base of ["plugins", "packages"]) {
    const baseDir = join(REPO_ROOT, base);
    if (!existsSync(baseDir)) continue;
    for (const dirent of readdirSync(baseDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const file = join(baseDir, dirent.name, "registry-entry.json");
      if (existsSync(file)) out.push(...readEntryFile(file));
    }
  }
  return out;
}

function collectCuratedEntries(): SourcedEntry[] {
  const out: SourcedEntry[] = [];
  if (!existsSync(CURATED_DIR)) return out;
  const walk = (dir: string) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.name.endsWith(".json")) {
        out.push(...readEntryFile(full));
      }
    }
  };
  walk(CURATED_DIR);
  return out;
}

export function collectFirstPartyEntries(): RegistryEntry[] {
  const sourced = [...collectPluginOwnedEntries(), ...collectCuratedEntries()];
  const byId = new Map<string, string>();
  for (const { entry, file } of sourced) {
    const existing = byId.get(entry.id);
    if (existing) {
      throw new Error(
        `[registry/generate] duplicate id "${entry.id}" in ${file} and ${existing}`,
      );
    }
    byId.set(entry.id, file);
  }
  return sourced.map((s) => s.entry).sort((a, b) => a.id.localeCompare(b.id));
}

export function generateFirstPartyRegistry(): {
  full: string;
  curated: string;
  channels: string;
  providers: string;
  shortIds: string;
  inventory: string;
} {
  const entries = collectFirstPartyEntries();
  return {
    full: `${JSON.stringify({ entries }, null, 2)}\n`,
    curated: `${JSON.stringify(collectCuratedAppDefinitions(entries), null, 2)}\n`,
    channels: `${JSON.stringify(collectChannelPluginMap(entries), null, 2)}\n`,
    providers: `${JSON.stringify(collectProviderPluginMap(entries), null, 2)}\n`,
    shortIds: `${JSON.stringify(collectShortIdPluginMap(entries), null, 2)}\n`,
    inventory: `${JSON.stringify(
      {
        membershipTargetKinds: MEMBERSHIP_TARGET_KINDS,
        connectors: collectConnectorTruthInventory(entries),
      },
      null,
      2,
    )}\n`,
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = generateFirstPartyRegistry();
  const artifacts: [string, string][] = [
    [GENERATED_PATH, biomeFormatJson(next.full, GENERATED_PATH)],
    [CURATED_DEFS_PATH, biomeFormatJson(next.curated, CURATED_DEFS_PATH)],
    [CHANNEL_MAP_PATH, biomeFormatJson(next.channels, CHANNEL_MAP_PATH)],
    [PROVIDER_MAP_PATH, biomeFormatJson(next.providers, PROVIDER_MAP_PATH)],
    [SHORTID_MAP_PATH, biomeFormatJson(next.shortIds, SHORTID_MAP_PATH)],
    [
      TRUTH_INVENTORY_PATH,
      biomeFormatJson(next.inventory, TRUTH_INVENTORY_PATH),
    ],
  ];
  if (check) {
    for (const [path, expected] of artifacts) {
      const current =
        existsSync(path) && statSync(path).isFile()
          ? readFileSync(path, "utf-8")
          : "";
      if (current !== expected) {
        console.error(
          `[registry/generate] ${path} is stale. Run \`bun run --cwd packages/registry generate:first-party\` and commit the result.`,
        );
        process.exit(1);
      }
    }
    console.log("[registry/generate] generated artifacts are up to date.");
    return;
  }
  for (const [path, content] of artifacts) writeFileSync(path, content);
  const count = JSON.parse(next.full).entries.length;
  const curatedCount = JSON.parse(next.curated).length;
  console.log(
    `[registry/generate] wrote ${count} entries + ${curatedCount} curated-app definitions`,
  );
}

if (import.meta.main) {
  main();
}
