/**
 * Live end-to-end smoke for #10832 Phase 2: drives the REAL route handlers
 * (ptyRoutes) with the REAL PtyService (true Bun PTY spawn) against the REAL
 * installed `claude` / `codex` CLIs. Proves:
 *   1. gate off (default)      -> 403 mentioning PTY_VENDOR_CLI_ENABLED
 *   2. store build + gate on   -> 403
 *   3. gate on, kind=claude    -> 200, real interactive TUI bytes on the PTY
 *   4. gate on, kind=codex     -> 200, real interactive TUI bytes on the PTY
 *
 * Run from this repository with:
 *   bun .github/issue-evidence/10832-pty-vendor-cli-phase2/live-vendor-cli-smoke.ts /tmp/claude-1000
 */
import { ptyRoutes } from "../../../plugins/plugin-pty/routes/pty-routes";
import { PtyService } from "../../../plugins/plugin-pty/services/pty-service";

const smokeCwd = process.argv[2] ?? "/tmp/claude-1000";
// biome-ignore lint/complexity/useRegexLiterals: regex literals with control-code escapes trip noControlCharactersInRegex.
const CSI_PATTERN = new RegExp(String.raw`\x1b\[[0-9;?]*[a-zA-Z]`, "g");
// biome-ignore lint/complexity/useRegexLiterals: regex literals with control-code escapes trip noControlCharactersInRegex.
const OSC_PATTERN = new RegExp(String.raw`\x1b\][^\x07]*\x07`, "g");
// biome-ignore lint/complexity/useRegexLiterals: regex literals with control-code escapes trip noControlCharactersInRegex.
const CONTROL_PATTERN = new RegExp(String.raw`[\x00-\x08\x0b-\x1f]`, "g");
const settings: Record<string, string> = {};
const svc = new PtyService(undefined, undefined, {
  allowedRoot: smokeCwd,
});

const runtime = {
  getSetting: (k: string) => settings[k],
  getService: (t: string) => (t === "PTY_SERVICE" ? svc : null),
} as never;

const spawnRoute = ptyRoutes.find((r) => r.name === "pty-spawn-session");
if (!spawnRoute?.routeHandler) throw new Error("spawn route missing");
const handler = spawnRoute.routeHandler;

function ctx(body: Record<string, unknown>) {
  return {
    runtime,
    body,
    headers: {},
    query: {},
    params: {},
    inProcess: true,
    isTrustedLocal: true,
  } as never;
}

function show(step: string, res: { status: number; body: unknown }) {
  console.log(`\n=== ${step} -> HTTP ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2).slice(0, 600));
}

function printablePtyOutput(raw: string): string {
  return raw
    .replace(CSI_PATTERN, "")
    .replace(OSC_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .trim();
}

try {
  // 1. gate off (default)
  show(
    "kind=claude, gate OFF (default)",
    await handler(ctx({ kind: "claude" })),
  );

  // 2. store build, gate on
  settings.PTY_VENDOR_CLI_ENABLED = "true";
  settings.ELIZA_BUILD_VARIANT = "store";
  show(
    "kind=codex, gate ON but ELIZA_BUILD_VARIANT=store",
    await handler(ctx({ kind: "codex" })),
  );
  delete settings.ELIZA_BUILD_VARIANT;

  // 3 + 4. gate on -> real spawns
  for (const kind of ["claude", "codex"] as const) {
    const res = await handler(
      ctx({ kind, cwd: smokeCwd, cols: 120, rows: 30 }),
    );
    show(`kind=${kind}, gate ON - real spawn`, res);
    const session = (res.body as { session?: { sessionId: string } }).session;
    if (!session) throw new Error(`no session for ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const raw = svc.getBufferedOutput(session.sessionId) ?? "";
    console.log(
      `--- first live TUI output from the real ${kind} CLI (${raw.length} raw bytes) ---`,
    );
    console.log(printablePtyOutput(raw).slice(0, 800));
    await svc.stopSession(session.sessionId);
    console.log(`--- ${kind} session stopped ---`);
  }

  console.log("\nLIVE SMOKE COMPLETE");
} finally {
  await svc.stop();
}
