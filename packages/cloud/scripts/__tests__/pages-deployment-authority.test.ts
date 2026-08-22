/**
 * Exercises the closed Cloudflare Pages authority and deployed-browser proof
 * contracts with deterministic provider records and public HTTP responses.
 */
import { describe, expect, test } from "bun:test";
import {
  createDeployedRendererProof,
  DEPLOYED_BROWSER_SMOKE_SCHEMA,
  PAGES_AUTHORITY_SCHEMA,
  parseDeployedRendererProof,
  parseWranglerPagesDeploymentOutput,
  verifyPublicPagesDeployment,
} from "../pages-deployment-authority.mjs";

const sourceSha = "87da9c8ba169440f0fb21dc613f7bc425c8014b6";
const deploymentId = "3d07ff31-d66e-4cf0-948c-3f44cd9ed23d";
const deploymentUrl = "https://5f02a912.eliza-app.pages.dev";
const aliasUrl = "https://develop.eliza-app.pages.dev";
const apiOrigin = "https://api-staging.eliza.app";
const buildId = "a".repeat(64);
const indexHtmlSha256 = "b".repeat(64);

function wranglerRecord(
  overrides: Record<string, unknown> = {},
  sessionOverrides: Record<string, unknown> = {},
): string {
  const session = {
    type: "wrangler-session",
    version: 1,
    wrangler_version: "4.100.0",
    command_line_args: [
      "pages",
      "deploy",
      "--project-name=eliza-app",
      "--branch=develop",
      `--commit-hash=${sourceSha}`,
      "--commit-dirty=false",
    ],
    log_file_path: "/tmp/wrangler.log",
    timestamp: "2026-08-21T19:59:59.999Z",
    ...sessionOverrides,
  };
  const summary = {
    type: "pages-deploy",
    version: 1,
    pages_project: "eliza-app",
    deployment_id: deploymentId,
    url: deploymentUrl,
    timestamp: "2026-08-21T20:00:00.000Z",
  };
  const detailed = {
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "eliza-app",
    deployment_id: deploymentId,
    url: deploymentUrl,
    alias: aliasUrl,
    environment: "preview",
    production_branch: "main",
    deployment_trigger: { metadata: { commit_hash: sourceSha } },
    timestamp: "2026-08-21T20:00:00.001Z",
    ...overrides,
  };
  return `${JSON.stringify(session)}\n${JSON.stringify(summary)}\n${JSON.stringify(detailed)}\n`;
}

function authority() {
  return parseWranglerPagesDeploymentOutput(wranglerRecord(), {
    expectedProject: "eliza-app",
    expectedCommit: sourceSha,
    expectedBranch: "develop",
    expectedAlias: aliasUrl,
    expectedEnvironment: "preview",
    expectedProductionBranch: "main",
    runId: "32500000001",
    runAttempt: "2",
  });
}

function rendererManifest() {
  return {
    schema: "elizaos.renderer.build/v1",
    buildId,
    indexHtmlSha256,
    assetCount: 42,
    builtAt: "2026-08-21T19:59:00.000Z",
    commit: sourceSha,
    variant: null,
    capacitorTarget: null,
    runtimeMode: null,
    playwrightTestAuth: false,
    iosApnsEnabled: null,
  };
}

function response(url: string, value: unknown) {
  return {
    ok: true,
    status: 200,
    url,
    text: async () => JSON.stringify(value),
  };
}

async function publicCheck(phase: "preflight" | "postflight") {
  const fetchImpl = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.origin === aliasUrl) {
      return response(
        `${aliasUrl}/eliza-renderer-build.json?source=${sourceSha}`,
        rendererManifest(),
      );
    }
    return response(`${apiOrigin}/api/health?source=${sourceSha}`, {
      commit: sourceSha,
      environment: "staging",
      status: "ok",
    });
  }) as unknown as typeof fetch;
  return verifyPublicPagesDeployment(authority(), {
    apiBase: apiOrigin,
    phase,
    fetchImpl,
  });
}

function remoteSmoke() {
  return {
    schema: DEPLOYED_BROWSER_SMOKE_SCHEMA,
    sourceSha,
    rendererOrigin: aliasUrl,
    rendererManifestCommit: sourceSha,
    rendererBuildId: buildId,
    cloudApiOrigin: apiOrigin,
    cloudEnvironment: "staging",
    outcome: "success",
  };
}

function latency() {
  return {
    schemaVersion: 1,
    lane: "app-live-e2e-cloud-staging",
    metric: "first-turn-latency",
    definition:
      "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
    firstTurnLatencyMs: 12_345,
  };
}

function continuity() {
  return {
    schemaVersion: 1,
    lane: "app-live-e2e-cloud-staging",
    challengeTurnCount: 1,
    noAdditionalChatSendAfterChallenge: true,
    personalIdentityEndpointPassed: true,
    reloadHistoryPassed: true,
    freshContextHistoryPassed: true,
    personalIdentityReused: true,
    runtimeBindingReused: true,
    apiBaseReused: true,
    forbiddenAgentMutationCount: 0,
    cleanupDisposition: "no-test-owned-agent",
    conversationHistoryDisposition: "preserved",
  };
}

describe("Pages deployment authority", () => {
  test("closes the exact Wrangler session and deployment records without publishing local metadata", () => {
    const parsed = authority();
    expect(parsed).toEqual({
      schema: PAGES_AUTHORITY_SCHEMA,
      sourceSha,
      workflow: { runId: 32500000001, runAttempt: 2 },
      project: "eliza-app",
      branch: "develop",
      pagesEnvironment: "preview",
      productionBranch: "main",
      deploymentUrl,
      aliasUrl,
      deploymentIdSha256:
        "eb251bd0455144d0f3c6642e81b5ad148ffbc82522239e94028b9154159222fc",
    });
    expect(JSON.stringify(parsed)).not.toContain(deploymentId);
    expect(JSON.stringify(parsed)).not.toContain("command_line_args");
    expect(JSON.stringify(parsed)).not.toContain("/tmp/wrangler.log");
  });

  test("rejects extra records, unexpected fields, and cross-record drift", () => {
    expect(() =>
      parseWranglerPagesDeploymentOutput(`${wranglerRecord()}{}\n`, {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "develop",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exactly three");
    expect(() =>
      parseWranglerPagesDeploymentOutput(
        wranglerRecord({ deployment_id: "other" }),
        {
          expectedProject: "eliza-app",
          expectedCommit: sourceSha,
          expectedBranch: "develop",
          expectedAlias: aliasUrl,
          expectedEnvironment: "preview",
          expectedProductionBranch: "main",
          runId: "1",
          runAttempt: "1",
        },
      ),
    ).toThrow("deployment_id differs");
    expect(() =>
      parseWranglerPagesDeploymentOutput(wranglerRecord({ unexpected: true }), {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "develop",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exact closed schema");
  });

  test("rejects missing or malformed Wrangler session records", () => {
    const withoutSession = wranglerRecord().split("\n").slice(1).join("\n");
    expect(() =>
      parseWranglerPagesDeploymentOutput(withoutSession, {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "develop",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exactly three");

    for (const sessionOverrides of [
      { wrangler_version: "4.99.0" },
      { command_line_args: ["deploy"] },
      { unexpected: true },
    ]) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(
          wranglerRecord({}, sessionOverrides),
          {
            expectedProject: "eliza-app",
            expectedCommit: sourceSha,
            expectedBranch: "develop",
            expectedAlias: aliasUrl,
            expectedEnvironment: "preview",
            expectedProductionBranch: "main",
            runId: "1",
            runAttempt: "1",
          },
        ),
      ).toThrow();
    }
  });

  test("binds the Wrangler command exactly to the attested release", () => {
    const validArgs = [
      "pages",
      "deploy",
      "--project-name=eliza-app",
      "--branch=develop",
      `--commit-hash=${sourceSha}`,
      "--commit-dirty=false",
    ];
    const mutations = [
      validArgs.map((argument) =>
        argument.startsWith("--commit-hash=")
          ? `--commit-hash=${"c".repeat(40)}`
          : argument,
      ),
      validArgs.map((argument) =>
        argument === "--project-name=eliza-app"
          ? "--project-name=other-app"
          : argument,
      ),
      validArgs.map((argument) =>
        argument === "--branch=develop" ? "--branch=main" : argument,
      ),
      validArgs.slice(0, -1),
      [...validArgs, "--skip-caching"],
    ];

    for (const commandLineArgs of mutations) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(
          wranglerRecord({}, { command_line_args: commandLineArgs }),
          {
            expectedProject: "eliza-app",
            expectedCommit: sourceSha,
            expectedBranch: "develop",
            expectedAlias: aliasUrl,
            expectedEnvironment: "preview",
            expectedProductionBranch: "main",
            runId: "1",
            runAttempt: "1",
          },
        ),
      ).toThrow("command_line_args do not match the release");
    }
  });

  test("requires exact commit, alias, environment, and production branch", () => {
    for (const [field, value] of [
      ["deployment_trigger", { metadata: { commit_hash: "c".repeat(40) } }],
      ["alias", "https://other.eliza-app.pages.dev"],
      ["environment", "production"],
      ["production_branch", "develop"],
    ] as const) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(wranglerRecord({ [field]: value }), {
          expectedProject: "eliza-app",
          expectedCommit: sourceSha,
          expectedBranch: "develop",
          expectedAlias: aliasUrl,
          expectedEnvironment: "preview",
          expectedProductionBranch: "main",
          runId: "1",
          runAttempt: "1",
        }),
      ).toThrow();
    }
  });
});

describe("deployed renderer proof", () => {
  test("binds public checks and remote smoke to one exact renderer", async () => {
    const proof = createDeployedRendererProof({
      authority: authority(),
      preflight: await publicCheck("preflight"),
      remoteSmoke: remoteSmoke(),
      latency: latency(),
      continuity: continuity(),
      postflight: await publicCheck("postflight"),
    });
    expect(parseDeployedRendererProof(proof)).toEqual(proof);
    expect(proof.sourceSha).toBe(sourceSha);
    expect(proof.remoteSmoke.outcome).toBe("success");
    expect(proof.continuity.forbiddenAgentMutationCount).toBe(0);
  });

  test("rejects a stale renderer manifest before browser auth", async () => {
    const fetchImpl = (async (url: string) => {
      const parsed = new URL(url);
      return parsed.origin === aliasUrl
        ? response(url, { ...rendererManifest(), commit: "c".repeat(40) })
        : response(url, { commit: sourceSha, environment: "staging" });
    }) as unknown as typeof fetch;
    await expect(
      verifyPublicPagesDeployment(authority(), {
        apiBase: apiOrigin,
        phase: "preflight",
        fetchImpl,
      }),
    ).rejects.toThrow("renderer manifest commit is stale");
  });

  test("rejects renderer drift between browser and postflight", async () => {
    const preflight = await publicCheck("preflight");
    const postflight = await publicCheck("postflight");
    expect(() =>
      createDeployedRendererProof({
        authority: authority(),
        preflight,
        remoteSmoke: remoteSmoke(),
        latency: latency(),
        continuity: continuity(),
        postflight: {
          ...postflight,
          renderer: { ...postflight.renderer, buildId: "c".repeat(64) },
        },
      }),
    ).toThrow("renderer changed");
  });

  test("rejects forged public manifest schema and commit identities", async () => {
    const preflight = await publicCheck("preflight");
    const postflight = await publicCheck("postflight");
    const inputs = {
      authority: authority(),
      preflight,
      remoteSmoke: remoteSmoke(),
      latency: latency(),
      continuity: continuity(),
      postflight,
    };
    expect(() =>
      createDeployedRendererProof({
        ...inputs,
        preflight: {
          ...preflight,
          renderer: {
            ...preflight.renderer,
            manifestSchema: "elizaos.renderer.build/v0",
          },
        },
      }),
    ).toThrow("renderer/API source identity is inconsistent");
    expect(() =>
      createDeployedRendererProof({
        ...inputs,
        postflight: {
          ...postflight,
          renderer: { ...postflight.renderer, commit: "b".repeat(40) },
        },
      }),
    ).toThrow("renderer/API source identity is inconsistent");
  });
});
