/**
 * Connector setup-routes contract test.
 *
 * This test pins the intended shared shape for connector setup routes.
 * Today most connectors diverge — see docs/first-run-contracts.md §5.
 * Normalization is tracked as a follow-up; expected failures use
 * `test.fails(...)` so the suite produces useful signal without blocking CI.
 *
 * The contract every connector plugin's setup-routes export MUST satisfy:
 *
 *   1. Path prefix is `/api/setup/<connector-name>/` — uniform, predictable.
 *   2. There is a `GET /api/setup/<connector-name>/status` endpoint that
 *      returns `{ connector: string, state: 'idle'|'configuring'|'paired'|'error',
 *      detail?: string }`. (Response shape is exercised at runtime, not here.)
 *   3. There is a `POST /api/setup/<connector-name>/start` that accepts the
 *      connector-specific config payload and transitions state to 'configuring'.
 *   4. There is a `POST /api/setup/<connector-name>/cancel` that returns state
 *      to 'idle'.
 *   5. Error responses follow `{ error: { code, message } }` — no bare strings.
 *      (Static analysis of error shapes is checked here as a best-effort
 *      grep for bare `error: "..."` literals.)
 *
 * The test reads each connector's setup-routes source file as text and extracts
 * the route entries via a minimal parser. This keeps the test side-effect-free
 * (no need to actually import + execute the plugin code) and gives the
 * normalization follow-up a precise spec to satisfy.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// ── Connector inventory ────────────────────────────────────────────────────

interface ConnectorTarget {
  /** Slug used in the intended `/api/setup/<name>/` path. */
  connector: string;
  /** Repo-relative path to the setup-routes source file. */
  file: string;
  /** Expected name of the `Route[]` export. */
  exportName: string;
  /** True once the connector has been migrated to the shared contract. */
  migrated?: boolean;
  /**
   * True when the connector also exposes post-setup data routes under
   * `/api/<connector>/` alongside the canonical `/api/setup/<connector>/`
   * setup endpoints. Rule 1 (prefix-only) stays `test.fails` in that case
   * because the data routes legitimately live outside `/api/setup/`.
   */
  hasDataRoutes?: boolean;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const CONNECTORS: ConnectorTarget[] = [
  {
    connector: "discord",
    file: "plugins/plugin-discord/setup-routes.ts",
    exportName: "discordSetupRoutes",
    migrated: true,
  },
  {
    connector: "telegram",
    file: "plugins/plugin-telegram/src/setup-routes.ts",
    exportName: "telegramSetupRoutes",
    migrated: true,
  },
  {
    connector: "signal",
    file: "plugins/plugin-signal/src/setup-routes.ts",
    exportName: "signalSetupRoutes",
    migrated: true,
  },
  {
    connector: "imessage",
    file: "plugins/plugin-imessage/src/setup-routes.ts",
    exportName: "imessageSetupRoutes",
    migrated: true,
  },
  {
    connector: "bluebubbles",
    file: "plugins/plugin-bluebubbles/src/setup-routes.ts",
    exportName: "blueBubblesSetupRoutes",
    migrated: true,
  },
];

// ── Source parsing ─────────────────────────────────────────────────────────

interface ParsedRoute {
  type: string;
  path: string;
}

interface ParsedExport {
  source: string;
  routes: ParsedRoute[];
  hasBareErrorString: boolean;
}

/**
 * Extract route entries from the `Route[]` export. Looks for the array
 * literal assigned to `export const <exportName>` (or in app-documents'
 * case, an `.map(...)` derived array — handled separately) and pulls
 * out each `{ type: "X", path: "Y" }` object.
 *
 * This is deliberately a regex-based parser, not a real AST walk: it
 * keeps the test self-contained and the contract surface is simple
 * enough that string scanning is sufficient.
 */
function parseExport(source: string, exportName: string): ParsedExport | null {
  const arrayDeclMatch = source.match(
    new RegExp(
      `export\\s+const\\s+${exportName}\\s*:[^=]*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`,
    ),
  );
  if (!arrayDeclMatch) return null;
  const body = arrayDeclMatch[1];

  const routes: ParsedRoute[] = [];

  // Direct array literal form: [{ type: "GET", path: "/x", ... }, ...]
  const entryRegex =
    /\{\s*type:\s*"(GET|POST|PUT|PATCH|DELETE|STATIC)"\s*,\s*path:\s*"([^"]+)"/g;
  let match = entryRegex.exec(body);
  while (match !== null) {
    routes.push({ type: match[1], path: match[2] });
    match = entryRegex.exec(body);
  }

  // app-documents declares routes by mapping over a DOCUMENT_ROUTES list.
  // Pick those up too when the export is derived via `.map(...)`.
  if (routes.length === 0) {
    const tableRegex =
      /\{\s*type:\s*"(GET|POST|PUT|PATCH|DELETE|STATIC)"\s*,\s*path:\s*"([^"]+)"\s*\}/g;
    match = tableRegex.exec(source);
    while (match !== null) {
      routes.push({ type: match[1], path: match[2] });
      match = tableRegex.exec(source);
    }
  }

  // Best-effort scan for bare `error: <string>` literal in response bodies —
  // the contract requires `{ error: { code, message } }` instead.
  // Matches `error: "..."`, `error: \`...\``, `error: '...'`, and the
  // common template-string form `error: \`...${err}\`` plus
  // `error: result.error ?? "..."`. Any of these indicates a flat-string
  // error response shape rather than a structured envelope.
  const bareErrorPatterns = [
    /\berror:\s*["`'][^"`']/,
    /\berror:\s*`/,
    /\berror:\s*\(err as Error\)\.message/,
    /\berror:\s*result\.error/,
    /\berror:\s*String\(/,
    /\berror:\s*\w+\s*\?\?\s*["'`]/,
    // Helpers that emit a flat `{ error: "..." }` response.
    /\bsendJsonError\s*\(/,
    /\bhttpSendJsonError\s*\(/,
    /\bwriteJsonError\b/,
  ];
  const hasBareErrorString = bareErrorPatterns.some((rx) => rx.test(source));

  return { source, routes, hasBareErrorString };
}

function loadConnector(target: ConnectorTarget): ParsedExport | null {
  const absPath = path.join(REPO_ROOT, target.file);
  if (!existsSync(absPath)) return null;
  const source = readFileSync(absPath, "utf8");
  return parseExport(source, target.exportName);
}

// ── Contract assertions ────────────────────────────────────────────────────

for (const target of CONNECTORS) {
  describe(`connector: ${target.connector}`, () => {
    const parsed = loadConnector(target);

    test("setup-routes source file exists", () => {
      expect(parsed, `missing ${target.file}`).not.toBeNull();
    });

    if (!parsed) return;

    test(`exports a non-empty Route[] as ${target.exportName}`, () => {
      expect(
        parsed.routes.length,
        "no routes parsed from export",
      ).toBeGreaterThan(0);
    });

    // For migrated connectors the contract rules must really PASS; for
    // unmigrated ones the failures are expected and pinned with `test.fails`
    // so the suite still produces useful signal.
    //
    // Rule 1 (prefix-only) is a stricter form: even after migration, some
    // connectors coexist with post-setup data routes under `/api/<connector>/`
    // (Discord, BlueBubbles, iMessage). For those, rule 1 stays `test.fails`
    // even though rules 2-5 pass. Connectors with no data routes (Signal,
    // Telegram) satisfy rule 1 directly.
    const contractTest = target.migrated ? test : test.fails;
    const prefixTest =
      target.migrated && !target.hasDataRoutes ? test : test.fails;

    // ── Contract rule 1: path prefix `/api/setup/<connector>/`
    prefixTest(`all routes use prefix /api/setup/${target.connector}/`, () => {
      const expectedPrefix = `/api/setup/${target.connector}/`;
      const offending = parsed.routes.filter(
        (r) => !r.path.startsWith(expectedPrefix),
      );
      expect(offending, `routes not under ${expectedPrefix}`).toEqual([]);
    });

    // ── Contract rule 2: GET /api/setup/<connector>/status
    contractTest(`exposes GET /api/setup/${target.connector}/status`, () => {
      const target_path = `/api/setup/${target.connector}/status`;
      const found = parsed.routes.some(
        (r) => r.type === "GET" && r.path === target_path,
      );
      expect(found, `missing GET ${target_path}`).toBe(true);
    });

    // ── Contract rule 3: POST /api/setup/<connector>/start
    contractTest(`exposes POST /api/setup/${target.connector}/start`, () => {
      const target_path = `/api/setup/${target.connector}/start`;
      const found = parsed.routes.some(
        (r) => r.type === "POST" && r.path === target_path,
      );
      expect(found, `missing POST ${target_path}`).toBe(true);
    });

    // ── Contract rule 4: POST /api/setup/<connector>/cancel
    contractTest(`exposes POST /api/setup/${target.connector}/cancel`, () => {
      const target_path = `/api/setup/${target.connector}/cancel`;
      const found = parsed.routes.some(
        (r) => r.type === "POST" && r.path === target_path,
      );
      expect(found, `missing POST ${target_path}`).toBe(true);
    });

    // ── Contract rule 5: error responses use { error: { code, message } }
    contractTest(
      "error responses use structured { error: { code, message } } envelope",
      () => {
        expect(
          parsed.hasBareErrorString,
          'found bare `error: "string"` in responses',
        ).toBe(false);
      },
    );
  });
}

// ── #10201: shared connector-setup contract (single source of truth) ────────
//
// `SetupState` / `SetupStatusResponse` / `SetupErrorResponse` were each
// re-declared verbatim in every connector's setup-routes file. They are now
// owned by `@elizaos/core` (`types/connector-setup.ts`) and re-exported from
// `@elizaos/app-core/api/setup-contract` for path stability. These tests pin
// that single definition end to end: the contract owner (core), the server
// host (app-core), and each client (connector plugin) must all reference the
// SAME `SetupState` — no local mirror may drift.

const CORE_CONTRACT = "packages/core/src/types/connector-setup.ts";
const APP_CORE_REEXPORT = "packages/app-core/src/api/setup-contract.ts";
const EXPECTED_SETUP_STATES = ["configuring", "error", "idle", "paired"];

// Every file that previously declared a local `type SetupState` mirror and now
// must reference the shared contract from `@elizaos/core` instead. (bluebubbles
// references it via `SetupStatusResponse`; telegram keeps a *specialized*
// `SetupStatusResponse` but still imports the shared `SetupState` — both are
// fine. The invariant pinned below is: no file re-declares `type SetupState`.)
const SETUP_STATE_CONSUMERS = [
  "plugins/plugin-bluebubbles/src/setup-routes.ts",
  "plugins/plugin-bluebubbles/src/data-routes.ts",
  "plugins/plugin-discord/setup-routes.ts",
  "plugins/plugin-discord/data-routes.ts",
  "plugins/plugin-discord-local/src/index.ts",
  "plugins/plugin-imessage/src/setup-routes.ts",
  "plugins/plugin-imessage/src/data-routes.ts",
  "plugins/plugin-signal/src/setup-routes.ts",
  "plugins/plugin-telegram/src/setup-routes.ts",
  "plugins/plugin-telegram/src/account-setup-routes.ts",
];

// The anti-drift invariant: no connector may re-declare the lifecycle union.
const LOCAL_SETUP_STATE_DECL = /^\s*(?:export\s+)?type\s+SetupState\s*=/m;
// References the shared contract from core — any of the connector-setup symbols
// counts (a file may need only `SetupStatusResponse` or `buildSetupError`).
// Matches both `import { ... } from "@elizaos/core"` and app-core's
// `export type { ... } from "@elizaos/core"` re-export.
const CORE_CONTRACT_REFERENCE =
  /(?:import|export)\s*(?:type\s*)?\{[^}]*\b(?:SetupState|SetupStatusResponse|SetupErrorResponse|buildSetupError|SETUP_ERROR_CODES)\b[^}]*\}\s*from\s*["']@elizaos\/core["']/s;

function readRepoFile(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("connector-setup shared contract (#10201)", () => {
  test("@elizaos/core owns the canonical SetupState union", () => {
    expect(
      existsSync(path.join(REPO_ROOT, CORE_CONTRACT)),
      `missing canonical contract module ${CORE_CONTRACT}`,
    ).toBe(true);
    const source = readRepoFile(CORE_CONTRACT);
    const match = source.match(/type\s+SetupState\s*=\s*([^;]+);/);
    expect(match, "core does not declare `type SetupState`").not.toBeNull();
    const members = (match?.[1] ?? "")
      .split("|")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();
    expect(members).toEqual(EXPECTED_SETUP_STATES);
  });

  test("app-core re-exports the contract from @elizaos/core (no local copy)", () => {
    const source = readRepoFile(APP_CORE_REEXPORT);
    expect(
      CORE_CONTRACT_REFERENCE.test(source),
      "app-core setup-contract must re-export the contract from @elizaos/core",
    ).toBe(true);
    expect(
      LOCAL_SETUP_STATE_DECL.test(source),
      "app-core setup-contract must not declare a local `type SetupState`",
    ).toBe(false);
  });

  for (const relPath of SETUP_STATE_CONSUMERS) {
    describe(relPath, () => {
      const source = readRepoFile(relPath);

      test("references the shared connector-setup contract from @elizaos/core", () => {
        expect(
          CORE_CONTRACT_REFERENCE.test(source),
          `${relPath} must import the connector-setup contract from @elizaos/core`,
        ).toBe(true);
      });

      test("does not re-declare a local `type SetupState`", () => {
        expect(
          LOCAL_SETUP_STATE_DECL.test(source),
          `${relPath} still declares a local SetupState — the mirror must be removed`,
        ).toBe(false);
      });
    });
  }
});
