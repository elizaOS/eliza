/**
 * Contract test for the in-repo Railway voice service definitions (#14374) and
 * the scheduled lane that keeps them alive. It guards two things that were pure
 * tribal knowledge before: (1) the free-cloud Kokoro TTS + Whisper STT services
 * exist as reproducible Dockerfile + railway.toml pairs under
 * packages/cloud/services/voice-*, and (2) the once-orphaned live contract test
 * (voice-kokoro-whisper-live.test.ts, previously referenced by zero workflows)
 * is wired into voice-live-e2e.yml with correct env gating, so a dead or drifted
 * Railway service surfaces as a red run rather than a silent user report.
 *
 * Deterministic: parses committed files only (Bun.TOML / Bun.YAML), no network,
 * no Railway. Actually deploying is an owner action — the READMEs carry the
 * `railway up` commands this test asserts are documented.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
function read(rel: string): string {
  return readFileSync(new URL(rel, repoRoot), "utf8");
}
function exists(rel: string): boolean {
  return existsSync(new URL(rel, repoRoot));
}

const LIVE_TEST_PATH =
  "packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts";
const WORKFLOW_PATH = ".github/workflows/voice-live-e2e.yml";
const CONTRACT_JOB = "voice-railway-contract";

const SERVICES = [
  {
    dir: "packages/cloud/services/voice-kokoro-tts",
    // The route contract these files exist to serve; the strings must appear in
    // the README so the contract is legible without reading the route code.
    contractPath: "/api/tts",
    deployCmd: "railway up --service kokoro-tts",
    urlVar: "ELIZA_VOICE_KOKORO_TTS_URL",
    // Exact `FROM` tag the Dockerfile ARG defaults to. Pinned to a manifest that
    // is verified to exist on ghcr — a bad tag (`railway up` fails at FROM) is
    // caught here instead of only at deploy. Re-verify the manifest before bumping.
    imageTag: "ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2",
  },
  {
    dir: "packages/cloud/services/voice-whisper-stt",
    contractPath: "/v1/audio/transcriptions",
    deployCmd: "railway up --service whisper-stt",
    urlVar: "ELIZA_VOICE_WHISPER_STT_URL",
    // 0.8.2-cpu is a real ghcr manifest that still serves the transcription +
    // /health contract; the prior 0.6.5-cpu was a 404 (`railway up` died at FROM).
    imageTag: "ghcr.io/speaches-ai/speaches:0.8.2-cpu",
  },
] as const;

interface RailwayToml {
  build?: { builder?: string; dockerfilePath?: string };
  deploy?: { healthcheckPath?: string; healthcheckTimeout?: number };
}

describe("Railway voice service definitions (#14374)", () => {
  for (const svc of SERVICES) {
    describe(svc.dir, () => {
      test("ships a Dockerfile that pins an upstream image by tag", () => {
        expect(exists(`${svc.dir}/Dockerfile`)).toBe(true);
        const dockerfile = read(`${svc.dir}/Dockerfile`);
        // A concrete FROM referencing an image arg — never a hard-coded literal.
        const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1] ?? "";
        expect(from.length).toBeGreaterThan(0);
        // The image is parameterised via an ARG default so a GPU variant is a
        // build-arg override, not an edit. Assert the ARG image line only (not
        // comment prose) so a version tag is present and never an unpinned :latest.
        const argImage = dockerfile.match(/^ARG\s+\w*IMAGE=(\S+)/m)?.[1] ?? "";
        expect(argImage).toMatch(/:[^:@\s]+$/);
        expect(argImage).not.toMatch(/:latest$/);
        // Pin the exact tag: a version that is present-but-nonexistent-on-ghcr
        // (the 0.6.5-cpu 404 that made `railway up` fail at FROM) passes the
        // generic "has a tag" checks above, so assert the manifest-verified tag.
        expect(argImage).toBe(svc.imageTag);
      });

      test("ships a valid railway.toml (Dockerfile builder + /health)", () => {
        expect(exists(`${svc.dir}/railway.toml`)).toBe(true);
        const toml = Bun.TOML.parse(
          read(`${svc.dir}/railway.toml`),
        ) as RailwayToml;
        expect(toml.build?.builder).toBe("DOCKERFILE");
        expect(toml.build?.dockerfilePath).toBe("Dockerfile");
        // The healthcheck path must match what railway probes AND what the live
        // test's services expose; the round-trip contract depends on /health.
        expect(toml.deploy?.healthcheckPath).toBe("/health");
        expect(typeof toml.deploy?.healthcheckTimeout).toBe("number");
      });

      test("documents the route contract and the owner deploy command", () => {
        expect(exists(`${svc.dir}/README.md`)).toBe(true);
        const readme = read(`${svc.dir}/README.md`);
        expect(readme).toContain(svc.contractPath);
        expect(readme).toContain(svc.deployCmd);
        // The README must name the repo var the scheduled lane reads, so the
        // deploy→lane wiring is discoverable from the service dir.
        expect(readme).toContain(svc.urlVar);
      });
    });
  }

  test("both services are recorded in the canonical Railway topology doc", () => {
    const railwayDoc = read("packages/cloud/infra/cloud/RAILWAY.md");
    for (const svc of SERVICES) {
      expect(railwayDoc).toContain(svc.dir);
    }
  });
});

interface WorkflowJob {
  "runs-on"?: unknown;
  if?: string;
  env?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string }>;
}
interface Workflow {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs?: Record<string, WorkflowJob>;
}

describe("scheduled live contract lane (voice-live-e2e.yml)", () => {
  const workflow = Bun.YAML.parse(read(WORKFLOW_PATH)) as Workflow;

  test("the once-orphaned live test is now referenced by this workflow", () => {
    expect(exists(LIVE_TEST_PATH)).toBe(true);
    expect(read(WORKFLOW_PATH)).toContain(LIVE_TEST_PATH);
  });

  test(`defines the ${CONTRACT_JOB} job that runs the live test`, () => {
    const job = workflow.jobs?.[CONTRACT_JOB];
    expect(job).toBeDefined();
    const runsTest = (job?.steps ?? []).some((s) =>
      s.run?.includes(LIVE_TEST_PATH),
    );
    expect(runsTest).toBe(true);
  });

  test("gates the live test with ELIZA_VOICE_LIVE_RAILWAY=1", () => {
    // Without the flag the test self-skips (test.skip), which would make the lane
    // vacuously green — the whole point is to hit the real services.
    expect(workflow.jobs?.[CONTRACT_JOB]?.env?.ELIZA_VOICE_LIVE_RAILWAY).toBe(
      "1",
    );
  });

  test("wires the service URLs from repo variables", () => {
    const env = workflow.jobs?.[CONTRACT_JOB]?.env ?? {};
    for (const svc of SERVICES) {
      const wired = Object.values(env).some((v) => v.includes(svc.urlVar));
      expect(wired).toBe(true);
    }
  });

  test("runs on schedule and is dispatchable", () => {
    // The lane must not require GPU/self-hosted staging — it hits public HTTPS,
    // so a GitHub-hosted runner is correct and keeps it cheap + always-available.
    expect(workflow.jobs?.[CONTRACT_JOB]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(
      workflow.on?.workflow_dispatch?.inputs?.run_railway_contract,
    ).toBeDefined();
  });
});
