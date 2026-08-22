/**
 * Static and executable contracts for managed-agent image publication.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/build-agent-image.yml", import.meta.url),
  "utf8",
);
const parsedWorkflow = Bun.YAML.parse(workflowText) as {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { options?: string[]; type?: string }>;
    };
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function githubExpression(value: string): string {
  return ["$", "{{ ", value, " }}"].join("");
}

function extractStepRunBlock(stepName: string): string {
  const stepPattern = new RegExp(
    `^      - name: ${escapeRegExp(stepName)}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses|id): |$(?![\\s\\S]))`,
    "m",
  );
  const stepMatch = workflowText.match(stepPattern);
  if (!stepMatch?.groups?.body) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }

  const runMatch = stepMatch.groups.body.match(
    /^ {8}run: \|\n(?<run>(?: {10}.*(?:\n|$))*)/m,
  );
  if (!runMatch?.groups?.run) {
    throw new Error(`Workflow step has no shell run block: ${stepName}`);
  }

  return runMatch.groups.run
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .trim();
}

function workflowStepNames(): string[] {
  return [...workflowText.matchAll(/^ {6}- name: (.+)$/gm)].map(
    (match) => match[1],
  );
}

function extractTurboFilters(runBlock: string): string[] {
  return [...runBlock.matchAll(/--filter=(?:'([^']+)'|"([^"]+)"|([^\\\s]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .sort();
}

function runPublicationResolver(
  eventName: string,
  requestedTarget: string,
): {
  exitCode: number;
  output: Map<string, string>;
  stderr: string;
} {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "eliza-image-publication-"),
  );
  const githubOutput = join(temporaryDirectory, "github-output");
  const result = spawnSync(
    "bash",
    ["-c", extractStepRunBlock("Resolve publication repository")],
    {
      env: {
        ...process.env,
        DEMO_IMAGE_REPOSITORY: "ghcr.io/elizaos/eliza-demo",
        EVENT_NAME: eventName,
        GITHUB_OUTPUT: githubOutput,
        IMAGE_NAME: "elizaOS/eliza",
        REGISTRY: "ghcr.io",
        REQUESTED_TARGET: requestedTarget,
      },
    },
  );
  const output = new Map<string, string>();
  if (existsSync(githubOutput)) {
    for (const line of readFileSync(githubOutput, "utf8").trim().split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) {
        output.set(line.slice(0, separator), line.slice(separator + 1));
      }
    }
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });

  return {
    exitCode: result.status ?? 1,
    output,
    stderr: result.stderr.toString(),
  };
}

function runDemoPromotion(overrides: Partial<Record<string, string>> = {}): {
  craneLog: string;
  exitCode: number;
  output: string;
  stderr: string;
} {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "eliza-image-promotion-"),
  );
  const bashEnv = join(temporaryDirectory, "bash-env");
  const craneLog = join(temporaryDirectory, "crane.log");
  const githubOutput = join(temporaryDirectory, "github-output");
  writeFileSync(
    bashEnv,
    `crane() {
  if [ "$1" = "copy" ]; then
    printf '%s\\n' "$2" "$3" > "$CRANE_LOG"
    return 0
  fi
  if [ "$1" = "digest" ]; then
    printf '%s\\n' "$MOCK_CRANE_DIGEST"
    return 0
  fi
  return 91
}
`,
  );
  const sourceDigest = `sha256:${"a".repeat(64)}`;
  const result = spawnSync(
    "bash",
    ["-c", extractStepRunBlock("Promote exact canonical digest to demo")],
    {
      env: {
        ...process.env,
        BASH_ENV: bashEnv,
        CRANE_LOG: craneLog,
        DESTINATION_REPOSITORY: "ghcr.io/elizaos/eliza-demo",
        GITHUB_OUTPUT: githubOutput,
        MOCK_CRANE_DIGEST: sourceDigest,
        SOURCE_DIGEST: sourceDigest,
        SOURCE_IMMUTABLE_TAG: "ghcr.io/elizaos/eliza:sha-abcdef0",
        SOURCE_REPOSITORY: "ghcr.io/elizaos/eliza",
        ...overrides,
      },
    },
  );
  const response = {
    craneLog: existsSync(craneLog) ? readFileSync(craneLog, "utf8") : "",
    exitCode: result.status ?? 1,
    output: existsSync(githubOutput) ? readFileSync(githubOutput, "utf8") : "",
    stderr: result.stderr.toString(),
  };
  rmSync(temporaryDirectory, { recursive: true, force: true });
  return response;
}

describe("build-agent-image workflow", () => {
  test("exposes only canonical and demo as closed manual publication targets", () => {
    expect(workflowText).toContain(`  workflow_dispatch:
    inputs:
      publication_target:
        description: Immutable GHCR destination for this manual build
        required: true
        default: canonical
        type: choice
        options:
          - canonical
          - demo`);
    expect(
      parsedWorkflow.on?.workflow_dispatch?.inputs?.publication_target,
    ).toEqual(
      expect.objectContaining({
        type: "choice",
        options: ["canonical", "demo"],
      }),
    );
    expect(workflowText).toContain("REGISTRY: ghcr.io");
    expect(workflowText).toContain(
      `IMAGE_NAME: ${githubExpression("github.repository")}`,
    );
    expect(workflowText).toContain(
      "DEMO_IMAGE_REPOSITORY: ghcr.io/elizaos/eliza-demo",
    );
    expect(workflowText.match(/inputs\.publication_target/g)).toHaveLength(1);
  });

  test("keeps push publication on the canonical repository", () => {
    const result = runPublicationResolver("push", "canonical");
    expect(result.exitCode).toBe(0);
    expect(result.output.get("name")).toBe("ghcr.io/elizaos/eliza");
    expect(result.output.get("metadata_name")).toBe("ghcr.io/elizaOS/eliza");
    expect(result.output.get("destination_name")).toBe("ghcr.io/elizaos/eliza");
    expect(result.output.get("publication_target")).toBe("canonical");

    expect(workflowText).toContain(
      `type=raw,value=develop,enable=${githubExpression("github.ref == 'refs/heads/develop'")}`,
    );
    expect(workflowText).toContain(
      `type=raw,value=stable,enable=${githubExpression("github.ref == 'refs/heads/main'")}`,
    );
    expect(workflowText).toContain(
      `type=raw,value=latest,enable=${githubExpression("github.ref == 'refs/heads/main'")}`,
    );
    expect(workflowText).toContain("type=sha,prefix=sha-,format=short");
  });

  test("allows the exact demo repository only on manual dispatch", () => {
    const manual = runPublicationResolver("workflow_dispatch", "demo");
    expect(manual.exitCode).toBe(0);
    expect(manual.output.get("name")).toBe("ghcr.io/elizaos/eliza");
    expect(manual.output.get("metadata_name")).toBe("ghcr.io/elizaOS/eliza");
    expect(manual.output.get("destination_name")).toBe(
      "ghcr.io/elizaos/eliza-demo",
    );
    expect(manual.output.get("publication_target")).toBe("demo");

    const rejected = runPublicationResolver("push", "demo");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.output.size).toBe(0);
    expect(rejected.stderr).toContain("available only to workflow_dispatch");
  });

  test("rejects arbitrary or shell-shaped publication targets without evaluation", () => {
    const sentinel = join(
      tmpdir(),
      `eliza-image-publication-sentinel-${process.pid}`,
    );
    rmSync(sentinel, { force: true });
    const malicious = runPublicationResolver(
      "workflow_dispatch",
      `demo$(touch ${sentinel})`,
    );

    expect(malicious.exitCode).not.toBe(0);
    expect(malicious.output.size).toBe(0);
    expect(malicious.stderr).toContain("Unsupported publication target");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("promotes the canonical verified digest into the selected demo repository", () => {
    expect(workflowText).toContain(
      `images: ${githubExpression("steps.image.outputs.metadata_name")}`,
    );
    expect(workflowText).toContain(
      `tags: ${githubExpression("steps.image.outputs.name")}:ci-boot-verify`,
    );
    expect(workflowText).toContain(
      `type=registry,ref=${githubExpression("steps.image.outputs.name")}:buildcache`,
    );
    expect(workflowText).toContain(
      `org.opencontainers.image.source=${githubExpression("github.server_url")}/${githubExpression("github.repository")}`,
    );

    const pushBlock = extractStepRunBlock("Push exact verified image");
    expect(pushBlock).toContain('"$PUBLISH_REPOSITORY":*)');
    expect(pushBlock).toContain('"$PUBLISH_REPOSITORY"@sha256:*)');
    expect(pushBlock).not.toContain("index .RepoDigests 0");
    expect(pushBlock).toContain(
      "Published image has no digest for the canonical repository",
    );
    expect(pushBlock).toContain(
      'tagged_image_id="$(docker image inspect --format',
    );
    expect(pushBlock).toContain(
      'if [ "$tagged_image_id" != "$verified_image_id" ]',
    );
    expect(pushBlock).toContain('"$PUBLISH_REPOSITORY":sha-*)');

    expect(workflowText).toContain(
      `subject-name: ${githubExpression("steps.image.outputs.name")}`,
    );
    expect(workflowText).toContain(
      "uses: imjasonh/setup-crane@feee3b6bb0d4c68370f256a4502498c9227e5c6b",
    );
    expect(workflowText).toContain("version: v0.20.6");

    const promotionBlock = extractStepRunBlock(
      "Promote exact canonical digest to demo",
    );
    expect(promotionBlock).toContain(
      '[ "$SOURCE_REPOSITORY" != "ghcr.io/elizaos/eliza" ]',
    );
    expect(promotionBlock).toContain(
      '[ "$DESTINATION_REPOSITORY" != "ghcr.io/elizaos/eliza-demo" ]',
    );
    expect(promotionBlock).toContain('"$SOURCE_REPOSITORY@$SOURCE_DIGEST"');
    expect(promotionBlock).toContain('crane digest "$destination_tag"');
    expect(promotionBlock).toContain(
      'if [ "$destination_digest" != "$SOURCE_DIGEST" ]',
    );

    expect(workflowText).toContain(
      `subject-name: ${githubExpression("steps.promote-demo.outputs.name")}`,
    );
    expect(workflowText).toContain(
      `subject-digest: ${githubExpression("steps.promote-demo.outputs.digest")}`,
    );

    const publicProbe = extractStepRunBlock(
      "Verify demo image is anonymously pullable",
    );
    expect(publicProbe).toContain(
      "node packages/scripts/verify-ghcr-anonymous-manifest.mjs",
    );
    expect(publicProbe).toContain('--repository "$GHCR_REPOSITORY"');
    expect(publicProbe).toContain('--digest "$EXPECTED_DIGEST"');
    expect(publicProbe).toContain('--image-id "$EXPECTED_IMAGE_ID"');

    expect(workflowText).toContain(
      `if: ${githubExpression("steps.image.outputs.publication_target == 'canonical'")}`,
    );
    expect(workflowText).not.toContain(
      "api.github.com/user/packages/container",
    );
    expect(workflowText).not.toContain(
      "api.github.com/orgs/elizaOS/packages/container/eliza-demo/visibility",
    );
    expect(workflowText).not.toContain(
      `images: ${githubExpression("env.REGISTRY")}/${githubExpression("env.IMAGE_NAME")}`,
    );
  });

  test("copies only an immutable canonical digest and rejects promotion drift", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const successful = runDemoPromotion();
    expect(successful.exitCode).toBe(0);
    expect(successful.craneLog).toBe(
      `ghcr.io/elizaos/eliza@${digest}\nghcr.io/elizaos/eliza-demo:sha-abcdef0\n`,
    );
    expect(successful.output).toContain(`digest=${digest}`);
    expect(successful.output).toContain("name=ghcr.io/elizaos/eliza-demo");

    const arbitraryDestination = runDemoPromotion({
      DESTINATION_REPOSITORY: "ghcr.io/elizaos/not-demo",
    });
    expect(arbitraryDestination.exitCode).not.toBe(0);
    expect(arbitraryDestination.craneLog).toBe("");
    expect(arbitraryDestination.stderr).toContain("closed allowlist");

    const mutableSource = runDemoPromotion({
      SOURCE_IMMUTABLE_TAG: "ghcr.io/elizaos/eliza:develop",
    });
    expect(mutableSource.exitCode).not.toBe(0);
    expect(mutableSource.craneLog).toBe("");
    expect(mutableSource.stderr).toContain("immutable SHA tag");

    const changedDigest = runDemoPromotion({
      MOCK_CRANE_DIGEST: `sha256:${"b".repeat(64)}`,
    });
    expect(changedDigest.exitCode).not.toBe(0);
    expect(changedDigest.stderr).toContain(
      "changed the canonical manifest digest",
    );
  });

  test("uses Turbo filters for Docker workspace artifact builds", () => {
    const runBlock = extractStepRunBlock("Build Docker workspace artifacts");

    expect(runBlock).toContain("node packages/scripts/run-turbo.mjs run build");
    expect(runBlock).toContain("--concurrency=8");
    expect(runBlock).not.toMatch(
      // Reject a bare package-manager `build` (the shell loop we migrated off),
      // but allow legitimately-named scripts like `build:foo` (the `:` guard).
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?![\w:])/,
    );
    expect(runBlock).not.toMatch(/\bfor\s+\w+\s+in\s+(?:packages|plugins)\b/);
    expect(runBlock).not.toMatch(/\bwhile\s+read\b/);

    expect(extractTurboFilters(runBlock)).toEqual([
      "@elizaos/agent",
      "@elizaos/app",
      "@elizaos/plugin-agent-skills",
      "@elizaos/plugin-browser",
      "@elizaos/plugin-capacitor-bridge",
      "@elizaos/plugin-coding-tools",
      "@elizaos/plugin-commands",
      "@elizaos/plugin-computeruse",
      "@elizaos/plugin-discord",
      "@elizaos/plugin-elizacloud",
      "@elizaos/plugin-imessage",
      "@elizaos/plugin-local-inference",
      "@elizaos/plugin-mcp",
      "@elizaos/plugin-native-filesystem",
      "@elizaos/plugin-pdf",
      "@elizaos/plugin-sql",
      "@elizaos/plugin-telegram",
      "@elizaos/plugin-video",
      "@elizaos/plugin-wallet",
      "@elizaos/plugin-whatsapp",
      "@elizaos/plugin-workflow",
      "@elizaos/plugin-x",
    ]);
  });

  test("repairs and proves runner Docker access before Buildx setup", () => {
    const steps = workflowStepNames();
    const accessIndex = steps.indexOf("Ensure Docker daemon access");
    const buildxIndex = workflowText.indexOf(
      "uses: docker/setup-buildx-action@",
    );

    expect(accessIndex).toBeGreaterThanOrEqual(0);
    expect(buildxIndex).toBeGreaterThan(
      workflowText.indexOf("- name: Ensure Docker daemon access"),
    );

    const runBlock = extractStepRunBlock("Ensure Docker daemon access");
    expect(runBlock).toContain("set -euo pipefail");
    expect(runBlock).toContain("docker info");
    expect(runBlock).toContain("/var/run/docker.sock");
    expect(runBlock).toContain("setfacl");
    expect(runBlock).toContain("RUNNER_ENVIRONMENT:-");
    expect(runBlock).not.toContain("docker info || true");
    expect(runBlock).not.toContain("chmod 666");
    expect(runBlock).not.toContain("chmod 777");
  });

  test("proves canonical and demo publication through one anonymous verifier", () => {
    const canonicalBlock = extractStepRunBlock(
      "Verify canonical image is anonymously pullable",
    );
    const demoBlock = extractStepRunBlock(
      "Verify demo image is anonymously pullable",
    );

    expect(canonicalBlock).toContain(
      "node packages/scripts/verify-ghcr-anonymous-manifest.mjs",
    );
    expect(demoBlock).toBe(canonicalBlock);
    expect(workflowText).toContain("GHCR_REPOSITORY: elizaos/eliza\n");
    expect(workflowText).toContain("GHCR_REPOSITORY: elizaos/eliza-demo\n");
    expect(workflowText).toContain(
      `EXPECTED_DIGEST: ${githubExpression("steps.push.outputs.digest")}`,
    );
    expect(workflowText).toContain(
      `EXPECTED_DIGEST: ${githubExpression("steps.promote-demo.outputs.digest")}`,
    );
    expect(workflowText).toContain(
      `EXPECTED_IMAGE_ID: ${githubExpression("steps.push.outputs.image_id")}`,
    );
  });

  test("does not retain the unsupported package-visibility mutation", () => {
    const verificationBlocks = [
      extractStepRunBlock("Verify canonical image is anonymously pullable"),
      extractStepRunBlock("Verify demo image is anonymously pullable"),
    ].join("\n");
    expect(workflowText).not.toContain("/user/packages/");
    expect(workflowText).not.toContain("/visibility");
    expect(verificationBlocks).not.toContain("secrets.GITHUB_TOKEN");
    expect(verificationBlocks).not.toContain("Authorization:");
    expect(workflowStepNames()).not.toContain("Make Docker image public");
  });

  test("keeps Node ESM dist rewrite after the Turbo build", () => {
    const steps = workflowStepNames();
    const buildIndex = steps.indexOf("Build Docker workspace artifacts");
    const rewriteIndex = steps.indexOf("Normalize plugin dist for Node ESM");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(rewriteIndex).toBeGreaterThan(buildIndex);

    const runBlock = extractStepRunBlock("Normalize plugin dist for Node ESM");
    expect(runBlock).toContain("for dist in plugins/*/dist");
    expect(runBlock).toContain(
      "packages/scripts/rewrite-dist-relative-imports-node-esm.mjs",
    );
    expect(runBlock).not.toMatch(
      // Reject a bare package-manager `build` (the shell loop we migrated off),
      // but allow legitimately-named scripts like `build:foo` (the `:` guard).
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?![\w:])/,
    );
  });
});
