/**
 * Guards every tracked e2e script family against hardcoded listen ports.
 * Fixed port constants die EADDRINUSE when CI fan-out places concurrent
 * harness jobs on one shared runner host (#18359). The inventory is every
 * git-tracked .mjs/.cjs/.js/.ts/.tsx/.sh file with an "e2e" path segment —
 * JS/TS orchestrators, Playwright setups, shell/Postgres/container verify
 * scripts — not just the run-*e2e*.mjs pair the guard originally scanned.
 *
 * Sanctioned alternatives: bind port 0 and read the port off the live server
 * handle; for child processes, the port-file handshake in
 * packages/scripts/e2e-ports.mjs; for suites whose workers must independently
 * compute the SAME port, the per-runner resolver in
 * packages/homepage/scripts/e2e-port.mjs. Probe-then-release allocation
 * (allocateFreePorts) is banned outright: it frees the socket before the
 * consumer binds, so another process can steal the port in between (TOCTOU).
 *
 * Out of scope: URL literals that point at external services' well-known
 * ports (e.g. a local Ollama at 11434) — those reference someone else's bind,
 * not a port this repository's harnesses claim. Genuinely fixed resources
 * that cannot collide are enumerated per file+port in ENUMERATED_RESIDUALS
 * with the reason; stale entries fail the suite so the list only ratchets
 * down. Runs against the real repository via git-tracked file discovery.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SCRIPT_EXTENSION = /\.(mjs|cjs|js|ts|tsx|sh)$/;

/** A file is e2e inventory when any path segment contains "e2e". */
function isE2eScript(file: string): boolean {
  if (!SCRIPT_EXTENSION.test(file)) return false;
  return file
    .toLowerCase()
    .split("/")
    .some((segment) => segment.includes("e2e"));
}

// The sanctioned port machinery itself: the resolver's deterministic local-dev
// fallback and this guard's fixture strings would otherwise self-flag.
const PORT_MACHINERY_FILES = new Set([
  // Per-runner deterministic resolver (fixed local-dev fallback by design).
  "packages/homepage/scripts/e2e-port.mjs",
  // The kernel-port handshake helper (binds nothing itself).
  "packages/scripts/e2e-ports.mjs",
  // This guard's adversarial fixtures.
  "packages/scripts/__tests__/e2e-port-hygiene.test.ts",
]);

// A numeric port assigned to a port-named binding (quoted or bare, any case —
// `const PORT = 13789`, `HTTP_PORT: "3000"`, `port: 36414`) or passed straight
// to listen(). Four to five digits keeps tiny literals (port 0, retry counts)
// and ms timeouts (6+ digits or different names) out of scope.
const JS_FIXED_PORT =
  /\b[A-Za-z_]*port\b["']?\s*[:=]\s*["']?(\d{4,5})\b|\.listen\(\s*(\d{4,5})\b/i;

// A fixed shell port: a line-leading *PORT= assignment (mid-line `-e PORT=n`
// is a container-internal env, not a host bind) or a docker publish with a
// literal host port (`-p 55444:5432`; `-p 5432` alone lets docker assign the
// host side and stays legal).
const SHELL_FIXED_PORT =
  /^\s*(?:export\s+)?[A-Za-z_]*PORT=(\d{4,5})\b|(?:^|\s)(?:-p|--publish)[= ]["']?(\d{4,5}):/i;

// Probe-then-release allocation is TOCTOU by construction; the helper was
// replaced by consumer-side bind + the port-file handshake. Any mention in an
// e2e script is a reintroduction.
const TOCTOU_ALLOCATOR = /\ballocateFreePorts\b/;

function isCommentLine(file: string, line: string): boolean {
  const trimmed = line.trim();
  if (file.endsWith(".sh")) return trimmed.startsWith("#");
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  );
}

function fixedPortIn(file: string, line: string): number | null {
  if (isCommentLine(file, line)) return null;
  const pattern = file.endsWith(".sh") ? SHELL_FIXED_PORT : JS_FIXED_PORT;
  const match = pattern.exec(line);
  if (!match) return null;
  const digits = match.slice(1).find((group) => group !== undefined);
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

// Enumerated residual: fixed ports that cannot collide under CI fan-out, kept
// visible here instead of silently exempted. Removing the underlying port
// without removing its entry fails the stale-entry test, so this only shrinks.
const ENUMERATED_RESIDUALS: { file: string; port: number; reason: string }[] = [
  {
    file: ".github/scripts/android-device-e2e/pr-device-smoke.sh",
    port: 31337,
    reason:
      "dedicated single-device Android lane; ELIZA_API_PORT is the documented override channel",
  },
  {
    file: ".github/scripts/android-device-e2e/route-coverage.sh",
    port: 31337,
    reason:
      "dedicated single-device Android lane; ELIZA_API_PORT is the documented override channel",
  },
  {
    file: "scripts/e2e-recordings/native-capture-common.mjs",
    port: 31337,
    reason:
      "resolver default with --api-port/ELIZA_API_PORT override precedence (#13624)",
  },
  {
    file: "packages/cloud/e2e/tests/provision.spec.ts",
    port: 3000,
    reason:
      "container-internal HTTP_PORT env for the provisioned app image; not a host bind",
  },
  {
    file: "plugins/plugin-local-inference/native/verify/e2e_loop_bench.mjs",
    port: 30000,
    reason:
      "randomized per-run base (30000 + rand*20000) for the spawned llama-server; not a fixed bind",
  },
];

function trackedE2eScripts(): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter(
      (file) => file && isE2eScript(file) && !PORT_MACHINERY_FILES.has(file),
    );
}

type Offense = { file: string; line: number; port: number; text: string };

function scanRepository(): Offense[] {
  const offenses: Offense[] = [];
  for (const file of trackedE2eScripts()) {
    const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const port = fixedPortIn(file, line);
      if (port !== null) {
        offenses.push({ file, line: index + 1, port, text: line.trim() });
      }
    });
  }
  return offenses;
}

describe("e2e script port hygiene", () => {
  it("inventories every e2e script family (guard is not vacuous)", () => {
    const files = trackedE2eScripts();
    expect(files.length).toBeGreaterThan(300);
    for (const exemplar of [
      // mjs orchestrator family
      "packages/ui/src/cloud/organization/__e2e__/run-credentials-e2e.mjs",
      // TS family (Playwright global setup, previously outside the scan)
      "packages/core/e2e/setup/global-setup.ts",
      // shell/Postgres/container family (previously outside the scan)
      "packages/cloud/shared/scripts/verify-e2e-container-db.sh",
      "packages/cloud/shared/scripts/verify-e2e-deploy.sh",
      // named in the #19839 review as escaping the original glob
      "packages/examples/code/tests/e2e/deterministic-app-build-replay.mjs",
    ]) {
      expect(files).toContain(exemplar);
    }
  });

  it("no e2e script hardcodes a listen port outside the enumerated residual", () => {
    const unexpected = scanRepository().filter(
      (offense) =>
        !ENUMERATED_RESIDUALS.some(
          (entry) => entry.file === offense.file && entry.port === offense.port,
        ),
    );
    expect(
      unexpected.map((o) => `${o.file}:${o.line}: ${o.text}`),
      "Hardcoded e2e listen ports collide under CI fan-out (#18359). Bind " +
        "port 0 and read the bound port off the server handle; for child " +
        "processes use the port-file handshake in " +
        "packages/scripts/e2e-ports.mjs; for same-port multi-process suites " +
        "use packages/homepage/scripts/e2e-port.mjs. A genuinely fixed " +
        "resource needs an ENUMERATED_RESIDUALS entry with its reason.",
    ).toEqual([]);
  });

  it("the enumerated residual only ratchets down (no stale entries)", () => {
    const offenses = scanRepository();
    const stale = ENUMERATED_RESIDUALS.filter(
      (entry) =>
        !offenses.some(
          (offense) =>
            offense.file === entry.file && offense.port === entry.port,
        ),
    );
    expect(
      stale.map((entry) => `${entry.file} (${entry.port})`),
      "Residual entry no longer matches any line — delete it so the " +
        "allowlist shrinks with the debt.",
    ).toEqual([]);
  });

  it("no e2e script reintroduces probe-then-release allocation (TOCTOU)", () => {
    const offenders: string[] = [];
    for (const file of trackedE2eScripts()) {
      const content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (TOCTOU_ALLOCATOR.test(content)) offenders.push(file);
    }
    expect(
      offenders,
      "allocateFreePorts probed and released sockets before the consumer " +
        "bound them, so another process could steal the port (#19839 " +
        "review). The consumer must bind port 0 itself; cross-process " +
        "consumers advertise via packages/scripts/e2e-ports.mjs.",
    ).toEqual([]);
  });

  it("rejects the JS/TS patterns this guard exists for", () => {
    expect(fixedPortIn("a.mjs", "const PAGE_PORT = 36414;")).toBe(36414);
    expect(fixedPortIn("a.ts", "const PORT = 13789;")).toBe(13789);
    expect(fixedPortIn("a.ts", '            HTTP_PORT: "3000",')).toBe(3000);
    expect(fixedPortIn("a.mjs", "server.listen(36414, host);")).toBe(36414);
    expect(fixedPortIn("a.mjs", "  port: 8917,")).toBe(8917);
    expect(fixedPortIn("a.mjs", "    port = 30000 + rand();")).toBe(30000);
    // Sanctioned shapes stay legal.
    expect(fixedPortIn("a.mjs", 'server.listen(0, "127.0.0.1");')).toBeNull();
    expect(fixedPortIn("a.mjs", "  port: 0,")).toBeNull();
    expect(
      fixedPortIn("a.mjs", "const PAGE_PORT = pageServer.port;"),
    ).toBeNull();
    expect(
      fixedPortIn("a.mjs", "const PORT = Number(process.env.PORT || 8899);"),
    ).toBeNull();
    expect(fixedPortIn("a.mjs", " * PORT=8899 node llm-proxy.mjs")).toBeNull();
  });

  it("rejects the shell/Postgres/container patterns this guard exists for", () => {
    expect(fixedPortIn("a.sh", "PGPORT=55444")).toBe(55444);
    expect(fixedPortIn("a.sh", "ELIZA_API_PORT=31337 \\")).toBe(31337);
    expect(fixedPortIn("a.sh", "export API_PORT=8080")).toBe(8080);
    expect(fixedPortIn("a.sh", 'docker run -p "55444:5432" img')).toBe(55444);
    expect(fixedPortIn("a.sh", "docker run --publish 8080:80 img")).toBe(8080);
    // Sanctioned shapes stay legal.
    expect(fixedPortIn("a.sh", "docker run -p 5432 img")).toBeNull();
    expect(fixedPortIn("a.sh", 'docker run -p "$PGPORT:5432" img')).toBeNull();
    expect(
      fixedPortIn("a.sh", 'PGPORT=$(sudo docker port "$PG" 5432/tcp)'),
    ).toBeNull();
    // Container-internal env, not a host bind.
    expect(fixedPortIn("a.sh", 'run -e PORT=3000 "$IMAGE_REF"')).toBeNull();
    expect(fixedPortIn("a.sh", "# PGPORT=55444")).toBeNull();
  });

  it("classifies the inventory by path segment and extension", () => {
    expect(isE2eScript("packages/core/e2e/setup/global-setup.ts")).toBe(true);
    expect(isE2eScript("packages/ui/src/cloud/__e2e__/run-x-e2e.mjs")).toBe(
      true,
    );
    expect(
      isE2eScript("packages/cloud/shared/scripts/verify-e2e-deploy.sh"),
    ).toBe(true);
    expect(isE2eScript(".github/scripts/android-device-e2e/smoke.sh")).toBe(
      true,
    );
    // Non-script artifacts and non-e2e paths stay out.
    expect(isE2eScript("packages/core/e2e/fixtures/session.json")).toBe(false);
    expect(isE2eScript("packages/core/src/runtime.ts")).toBe(false);
  });
});
