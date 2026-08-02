/**
 * Proves the public scoring contract with deterministic GitHub-shaped records,
 * including the anti-gaming caps and provenance parsing used by live snapshots.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertLeaderboardSnapshot,
  assertPublishableLeaderboardSnapshot,
  assessEvidence,
  assessModelAttribution,
  createLeaderboardSnapshot,
  dedupeByNodeId,
  type EvidenceCategory,
  type GitHubActor,
  type GitHubTextSource,
  hasMaterialTestChange,
  type IssueRecord,
  LEADERBOARD_REPOSITORY,
  type LeaderboardInput,
  MATERIAL_TEST_ADDITIONS,
  MATERIAL_TEST_CHURN,
  type PullRequestRecord,
  pullRequestTextSources,
  qualifiesResolvedIssue,
  SCORE_CAPS,
  SCORE_RULE_VERSION,
  type VerifiedEvidenceArtifact,
} from "./leaderboard";

const NOW = "2026-07-30T12:00:00.000Z";
const WINDOW_FROM = "2026-06-30T12:00:00.000Z";
const VERIFICATION_FROM = "2026-07-23T12:00:00.000Z";

function actor(login: string, kind: GitHubActor["kind"] = "User"): GitHubActor {
  return {
    id: `ACTOR_${login}`,
    login,
    avatarUrl: `https://avatars.githubusercontent.com/${login}`,
    url: `https://github.com/${login}`,
    kind,
  };
}

function textSource(
  id: string,
  body: string,
  author: GitHubActor = actor("author"),
  kind: GitHubTextSource["kind"] = "comment",
): GitHubTextSource {
  const commentNumber = [...id].reduce(
    (value, character) => value + character.charCodeAt(0),
    1,
  );
  return {
    id,
    artifactId: "PR_1",
    kind,
    body,
    url: `https://github.com/elizaOS/eliza/pull/1#issuecomment-${commentNumber}`,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    author,
    authorAssociation: "MEMBER",
  };
}

const TEST_EVIDENCE_ROW_CATEGORY = new Map<string, EvidenceCategory>([
  ["after-screenshots", "screenshot"],
  ["backend-logs", "logs"],
  ["before-screenshots", "screenshot"],
  ["domain-artifacts", "domain-artifact"],
  ["frontend-logs", "logs"],
  ["llm-trajectory", "trajectory"],
  ["walkthrough-video", "video"],
]);

function verifiedSourceEvidence(
  source: GitHubTextSource,
  pullRequestMergedAt: string | null = "2026-07-30T11:00:00.000Z",
  pullRequestUpdatedAt = "2026-07-30T11:00:00.000Z",
): VerifiedEvidenceArtifact[] {
  const markers = [
    ...source.body.matchAll(/<!--\s*evidence-row:([a-z-]+)\s*-->/gi),
  ];
  return markers.flatMap((marker, index) => {
    const category = TEST_EVIDENCE_ROW_CATEGORY.get(marker[1].toLowerCase());
    if (!category) return [];
    const next = markers[index + 1];
    const row = source.body.slice(
      marker.index + marker[0].length,
      next?.index ?? source.body.length,
    );
    const identities = new Set<string>();
    for (const match of row.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
      identities.add(
        `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}`,
      );
    }
    return [...identities].map((artifactIdentity) => ({
      pullRequestId: source.artifactId,
      pullRequestMergedAt,
      pullRequestHeadOid: "a".repeat(40),
      pullRequestUpdatedAt,
      sourceId: source.id,
      sourceBody: source.body,
      sourceUpdatedAt: source.updatedAt,
      category,
      artifactIdentity,
      contentSha256: createHash("sha256")
        .update(artifactIdentity)
        .digest("hex"),
    }));
  });
}

function verifiedPullRequestEvidence(
  pullRequests: PullRequestRecord[],
): VerifiedEvidenceArtifact[] {
  return pullRequests.flatMap((pullRequest) =>
    pullRequestTextSources(pullRequest).flatMap((source) =>
      verifiedSourceEvidence(
        source,
        pullRequest.mergedAt ??
          (() => {
            throw new Error("Test verified pull request must be merged");
          })(),
        pullRequest.updatedAt,
      ),
    ),
  );
}

function machineAttribution(
  provider: string,
  model: string,
  client = "codex-desktop",
  skillRevision = "N/A - unit test does not invoke the contribution skill",
): string {
  return [
    `AI provider/model: ${provider} / ${model}`,
    `Client / agent tooling: ${client}`,
    `Contribution skill revision: ${skillRevision}`,
    "Attribution status: self-reported",
    "— [test-agent]",
    `<!-- eliza-computer-attribution:v1 ${JSON.stringify({
      provider: provider.toLowerCase(),
      model,
      client,
      skill_revision: skillRevision,
    })} -->`,
  ].join("\n");
}

function pullRequest(
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  const record: PullRequestRecord = {
    id: "PR_1",
    number: 1,
    title: "Finish the contribution path",
    url: "https://github.com/elizaOS/eliza/pull/1",
    body: "",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-30T11:00:00.000Z",
    lastEditedAt: null,
    mergedAt: "2026-07-30T11:00:00.000Z",
    headRefOid: "a".repeat(40),
    isDraft: false,
    reviewDecision: "APPROVED",
    activeReviewRequestCount: 0,
    author: actor("author"),
    assignees: [],
    labels: [],
    files: [],
    comments: [],
    reviews: [],
    closingIssueIds: [],
    additions: 20,
    deletions: 4,
    changedFiles: 2,
    commitCount: 2,
    ...overrides,
  };
  return {
    ...record,
    url:
      overrides.url ?? `https://github.com/elizaOS/eliza/pull/${record.number}`,
  };
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  const record: IssueRecord = {
    id: "ISSUE_1",
    number: 2,
    title: "Reproduce the scheduling failure",
    url: "https://github.com/elizaOS/eliza/issues/2",
    body: "",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-30T11:00:00.000Z",
    closedAt: "2026-07-30T11:00:00.000Z",
    stateReason: "COMPLETED",
    author: actor("reporter"),
    assignees: [],
    labels: [{ id: "LABEL_CONFIRMED", name: "confirmed", color: "238636" }],
    comments: [],
    closedByPullRequests: [],
    ...overrides,
  };
  return {
    ...record,
    url:
      overrides.url ??
      `https://github.com/elizaOS/eliza/issues/${record.number}`,
  };
}

function input(overrides: Partial<LeaderboardInput> = {}): LeaderboardInput {
  const mergedPullRequests = overrides.mergedPullRequests ?? [];
  const resolvedIssues = overrides.resolvedIssues ?? [];
  return {
    generatedAt: NOW,
    windowFrom: WINDOW_FROM,
    windowTo: NOW,
    sourceUpdatedAt: NOW,
    source: {
      provider: "github-graphql",
      fetchedAt: NOW,
      cutoffAt: NOW,
      repositoryId: "REPO_1",
      requestCount: 12,
      searchSliceCount: 30,
      rateLimit: {
        cost: 2,
        limit: 5_000,
        remaining: 4_800,
        resetAt: "2026-07-30T13:00:00.000Z",
      },
      counts: {
        mergedPullRequests: 0,
        detailedMergedPullRequests: 0,
        closedIssues: 0,
        detailedClosedIssues: 0,
        resolvedIssues: 0,
        openIssues: 0,
        openPullRequests: 0,
      },
      verificationWindow: {
        days: 7,
        from: VERIFICATION_FROM,
        to: NOW,
      },
      evidenceVerification: {
        status: "complete",
        sourceCount: 0,
        artifactCount: 0,
        maxSources: 64,
        maxArtifacts: 64,
      },
    },
    mergedPullRequestOutcomes: mergedPullRequests.map((pullRequest) => ({
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      body: pullRequest.body,
      createdAt: pullRequest.createdAt,
      updatedAt: pullRequest.updatedAt,
      mergedAt:
        pullRequest.mergedAt ??
        (() => {
          throw new Error("Test merged pull request must have mergedAt");
        })(),
      author: pullRequest.author,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
    })),
    mergedPullRequests,
    closedIssueCount: resolvedIssues.length,
    resolvedIssues,
    openIssues: [],
    openPullRequests: [],
    verificationWindowFrom: VERIFICATION_FROM,
    verifiedEvidence: [],
    ...overrides,
  };
}

describe("model attribution", () => {
  it("extracts exact visible declarations and valid machine markers", () => {
    const source = textSource(
      "COMMENT_1",
      machineAttribution(
        "OpenAI",
        "gpt-5.6-sol",
        "codex-desktop",
        "elizaOS/eliza@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:packages/skills/skills/contribute-to-eliza",
      ),
    );

    const result = assessModelAttribution([source]);

    expect(result.invalidMarkers).toEqual([]);
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      identifier: "openai/gpt-5.6-sol",
      client: "codex-desktop",
      skillRevision:
        "elizaOS/eliza@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:packages/skills/skills/contribute-to-eliza",
      format: "machine-marker",
      status: "self-reported",
    });
  });

  it("rejects vague names and reports malformed markers without guessing", () => {
    const source = textSource(
      "COMMENT_2",
      [
        "Model: GPT 5",
        "<!-- eliza-computer-attribution:v1 {not-json} -->",
      ].join("\n"),
    );

    const result = assessModelAttribution([source]);

    expect(result.declarations).toEqual([]);
    expect(result.invalidMarkers).toEqual([
      expect.objectContaining({
        sourceId: "COMMENT_2",
        reason: "marker JSON is malformed",
      }),
    ]);
  });

  it("rejects placeholder, extra-field, and visible-marker mismatches", () => {
    const placeholder = textSource(
      "COMMENT_PLACEHOLDER_MARKER",
      [
        "AI provider/model: provider / model",
        "Client / agent tooling: client",
        "Contribution skill revision: N/A - test fixture",
        "Attribution status: self-reported",
        '<!-- eliza-computer-attribution:v1 {"provider":"provider","model":"model","client":"client","skill_revision":"N/A - test fixture"} -->',
      ].join("\n"),
    );
    const extraField = textSource(
      "COMMENT_EXTRA_MARKER_FIELD",
      machineAttribution("OpenAI", "gpt-5.6-sol").replace(
        '"skill_revision":',
        '"session_id":"private","skill_revision":',
      ),
    );
    const mismatch = textSource(
      "COMMENT_MARKER_MISMATCH",
      machineAttribution("OpenAI", "gpt-5.6-sol").replace(
        '"client":"codex-desktop"',
        '"client":"different-client"',
      ),
    );
    const missingLane = textSource(
      "COMMENT_MISSING_LANE",
      machineAttribution("OpenAI", "gpt-5.6-sol").replace(
        "— [test-agent]\n",
        "",
      ),
    );
    const genericProvider = textSource(
      "COMMENT_GENERIC_PROVIDER",
      machineAttribution("OpenAI", "gpt-5.6-sol")
        .replace("AI provider/model: OpenAI /", "AI provider/model: AI /")
        .replace('"provider":"openai"', '"provider":"ai"'),
    );
    const noProvider = textSource(
      "COMMENT_NO_PROVIDER",
      machineAttribution("OpenAI", "gpt-5.6-sol")
        .replace("AI provider/model: OpenAI /", "AI provider/model: None /")
        .replace('"provider":"openai"', '"provider":"none"'),
    );
    const noModel = textSource(
      "COMMENT_NO_MODEL",
      machineAttribution("OpenAI", "gpt-5.6-sol")
        .replace("gpt-5.6-sol", "N/A")
        .replace('"model":"gpt-5.6-sol"', '"model":"N/A"'),
    );

    const result = assessModelAttribution([
      placeholder,
      extraField,
      mismatch,
      missingLane,
      genericProvider,
      noProvider,
      noModel,
    ]);

    expect(
      result.declarations.filter(
        (declaration) => declaration.format === "machine-marker",
      ),
    ).toEqual([]);
    expect(
      result.declarations.filter(
        (declaration) =>
          declaration.sourceId === "COMMENT_GENERIC_PROVIDER" ||
          declaration.sourceId === "COMMENT_NO_PROVIDER" ||
          declaration.sourceId === "COMMENT_NO_MODEL",
      ),
    ).toEqual([]);
    expect(result.invalidMarkers).toEqual([
      expect.objectContaining({
        sourceId: "COMMENT_PLACEHOLDER_MARKER",
        reason: "provider must be a concrete lowercase provider slug",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_EXTRA_MARKER_FIELD",
        reason:
          "marker must contain only provider, model, client, and skill_revision",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_MARKER_MISMATCH",
        reason: "marker fields do not match the visible attribution footer",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_MISSING_LANE",
        reason: "marker requires exactly one terminal lane signature",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_GENERIC_PROVIDER",
        reason: "provider must be a concrete lowercase provider slug",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_NO_PROVIDER",
        reason: "provider must be a concrete lowercase provider slug",
      }),
      expect.objectContaining({
        sourceId: "COMMENT_NO_MODEL",
        reason: "model must be an exact model identifier",
      }),
    ]);
  });

  it("parses both canonical visible formats and preserves exact identifiers", () => {
    const modelsLine = textSource(
      "COMMENT_MODELS",
      "Models: Anthropic/claude-opus-4-1",
    );
    const providerModelLine = textSource(
      "COMMENT_PROVIDER_MODEL",
      "AI provider/model: OpenAI / gpt-5.6-sol",
    );

    const result = assessModelAttribution([modelsLine, providerModelLine]);

    expect(
      result.declarations.map((declaration) => declaration.identifier),
    ).toEqual(["Anthropic/claude-opus-4-1", "OpenAI/gpt-5.6-sol"]);
    expect(
      result.declarations.map((declaration) => declaration.format),
    ).toEqual(["visible-declaration", "visible-declaration"]);
  });

  it("recognizes the canonical pull-request model row", () => {
    const source = textSource(
      "COMMENT_CANONICAL_MODEL_ROW",
      "- Model(s) used: `openai/gpt-5.6-sol`, anthropic/claude-opus-4.1",
    );

    expect(
      assessModelAttribution([source]).declarations.map(
        (declaration) => declaration.identifier,
      ),
    ).toEqual(["openai/gpt-5.6-sol", "anthropic/claude-opus-4.1"]);
  });

  it("does not count a marker prefix without its JSON payload", () => {
    const source = textSource(
      "COMMENT_MARKER_ONLY",
      "<!-- eliza-computer-attribution:v1 -->",
    );

    const result = assessModelAttribution([source]);

    expect(result.declarations).toEqual([]);
    expect(result.invalidMarkers).toEqual([
      expect.objectContaining({
        sourceId: "COMMENT_MARKER_ONLY",
        reason: "marker JSON is malformed",
      }),
    ]);
  });

  it("reports complete, partial, missing, and invalid source coverage", () => {
    const attributed = textSource(
      "COMMENT_ATTRIBUTED",
      "AI provider/model: OpenAI / gpt-5.6-sol",
      actor("attributed"),
    );
    const humanOnly = textSource(
      "COMMENT_HUMAN",
      "No - human-only contribution",
      actor("human"),
    );
    const missing = textSource(
      "COMMENT_MISSING",
      "CLAIMING: I reproduced the failure and verified the output.",
      actor("missing"),
    );
    const invalid = textSource(
      "COMMENT_INVALID",
      "<!-- eliza-computer-attribution:v1 {broken} -->",
      actor("invalid"),
    );
    const bot = textSource(
      "COMMENT_BOT_ATTRIBUTION",
      "No model footer here.",
      actor("automation", "Bot"),
    );

    expect(assessModelAttribution([attributed, humanOnly]).coverage).toEqual({
      status: "complete",
      eligibleSourceCount: 2,
      validSourceCount: 2,
      missingSourceCount: 0,
      invalidSourceCount: 0,
      humanOnlySourceCount: 1,
    });
    expect(
      assessModelAttribution([attributed, humanOnly, missing, invalid, bot])
        .coverage,
    ).toEqual({
      status: "partial",
      eligibleSourceCount: 4,
      validSourceCount: 2,
      missingSourceCount: 2,
      invalidSourceCount: 1,
      humanOnlySourceCount: 1,
    });
    expect(assessModelAttribution([missing]).coverage.status).toBe("missing");
    expect(assessModelAttribution([invalid]).coverage.status).toBe("invalid");
  });

  it("does not classify ordinary human discussion as missing attribution", () => {
    for (const [index, discussion] of [
      "Looks good to me.",
      "The `AI provider/model:` field in your comment is malformed.",
      "> AI provider/model: quoted / example\n\nThis is quoted policy text.",
      "```text\nAI provider/model: example / example-model\n```",
      "````text\nCLAIMING: policy example\n```\nAI provider/model: example / example-model\n````",
      "    CLAIMING REVIEW: indented policy example",
      "~~~text\nAI assistance: no - human-only comment\n~~~",
    ].entries()) {
      expect(
        assessModelAttribution([
          textSource(`COMMENT_DISCUSSION_${index}`, discussion, actor("human")),
        ]).coverage,
      ).toMatchObject({
        eligibleSourceCount: 0,
        missingSourceCount: 0,
        validSourceCount: 0,
      });
    }
  });

  it("ignores quoted and fenced marker examples around a real machine footer", () => {
    for (const prefix of [
      '> <!-- eliza-computer-attribution:v1 {"provider":"fake"} -->',
      '~~~text\n<!-- eliza-computer-attribution:v1 {"provider":"fake"} -->\n~~~',
      "````text\n— [example-agent]\n```\n````",
    ]) {
      const source = textSource(
        `COMMENT_CONTEXT_${prefix.length}`,
        `${prefix}\n\n${machineAttribution("OpenAI", "gpt-5.6-sol")}`,
      );
      const result = assessModelAttribution([source]);
      expect(result.invalidMarkers).toEqual([]);
      expect(result.declarations).toHaveLength(1);
      expect(result.declarations[0]).toMatchObject({
        identifier: "openai/gpt-5.6-sol",
        format: "machine-marker",
      });
    }
  });

  it("does not let fenced model examples satisfy a real claim", () => {
    const source = textSource(
      "COMMENT_CLAIM_WITH_FENCED_MODEL",
      [
        "CLAIMING: fix the scheduler",
        "",
        "```text",
        "AI provider/model: OpenAI / gpt-5.6-sol",
        "```",
      ].join("\n"),
    );
    const result = assessModelAttribution([source]);
    expect(result.declarations).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "missing",
      eligibleSourceCount: 1,
      validSourceCount: 0,
    });
  });

  it("does not mistake template guidance for a human-only declaration", () => {
    const untouchedGuidance = textSource(
      "COMMENT_TEMPLATE_GUIDANCE",
      [
        "Human-only work must say so explicitly.",
        "- AI assistance: `yes` / `no - human-only contribution`",
        "AI assistance: yes / no - human-only report",
      ].join("\n"),
    );

    expect(assessModelAttribution([untouchedGuidance]).coverage).toMatchObject({
      status: "missing",
      eligibleSourceCount: 1,
      validSourceCount: 0,
      humanOnlySourceCount: 0,
    });
  });

  it("recognizes canonical human-only issue, epic, and request values", () => {
    for (const [index, body] of [
      "AI assistance: no - human-only report",
      "AI assistance: no - human-only epic",
      "AI assistance: no - human-only request",
    ].entries()) {
      expect(
        assessModelAttribution([
          textSource(`COMMENT_HUMAN_ONLY_${index}`, body),
        ]).coverage,
      ).toMatchObject({
        status: "complete",
        humanOnlySourceCount: 1,
      });
    }
  });
});

describe("evidence assessment", () => {
  it("awards each concrete evidence category once and caps the PR at six", () => {
    const source = textSource(
      "COMMENT_EVIDENCE",
      [
        "<!-- evidence-row:after-screenshots -->",
        "After desktop screenshot: https://github.com/user-attachments/assets/image-id",
        "<!-- evidence-row:walkthrough-video -->",
        "Video walkthrough: https://github.com/user-attachments/assets/video-id",
        "<!-- evidence-row:backend-logs -->",
        "Backend logs: https://github.com/user-attachments/assets/log-id",
        "<!-- evidence-row:llm-trajectory -->",
        "Trajectory: https://github.com/elizaOS/eliza/actions/runs/123/artifacts/456",
        "<!-- evidence-row:domain-artifacts -->",
        "Transaction: https://etherscan.io/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ].join("\n"),
      actor("author"),
      "body",
    );

    const result = assessEvidence(
      [source, source],
      verifiedSourceEvidence(source),
    );

    expect(result.points).toBe(6);
    expect(result.categories).toEqual([
      "domain-artifact",
      "logs",
      "screenshot",
      "trajectory",
      "video",
    ]);
    expect(
      result.findings.find((finding) => finding.category === "video")?.points,
    ).toBe(2);
  });

  it("does not turn N/A template rows or bot output into evidence", () => {
    const human = textSource(
      "COMMENT_NA",
      [
        "Screenshot: N/A - no user interface",
        "Video: N/A - no user interface",
        "Logs: N/A - not captured",
      ].join("\n"),
    );
    const bot = textSource(
      "COMMENT_BOT",
      "![CI screenshot](https://example.com/ci.png)",
      actor("checks", "Bot"),
    );

    expect(assessEvidence([human, bot])).toMatchObject({
      points: 0,
      categories: [],
    });
  });

  it("rejects arbitrary media links, bare checksums, and unstructured logs", () => {
    const source = textSource(
      "COMMENT_UNSTRUCTURED",
      [
        "Screenshot: ![desktop](https://example.com/desktop.png)",
        "Video: https://example.com/walkthrough.mp4",
        "Trajectory: https://example.com/run.jsonl",
        "sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Transaction: https://etherscan.io/tx/not-a-transaction",
        "Backend logs:",
        "```text",
        "[Runtime] this plausible-looking block is outside a stable evidence row",
        "```",
      ].join("\n"),
    );

    expect(assessEvidence([source])).toMatchObject({
      points: 0,
      categories: [],
    });
  });

  it("does not score an attachment outside a stable evidence row", () => {
    const source = textSource(
      "COMMENT_ATTACHMENT",
      "Mobile screenshot: https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc",
      actor("author"),
      "body",
    );

    expect(
      assessEvidence([source], verifiedSourceEvidence(source)),
    ).toMatchObject({
      points: 0,
      categories: [],
    });
  });

  it("does not score a forty-character fenced string as logs", () => {
    const source = textSource(
      "COMMENT_FAKE_INLINE_LOG",
      [
        "<!-- evidence-row:backend-logs -->",
        "```text",
        "x".repeat(40),
        "```",
      ].join("\n"),
      actor("author"),
      "body",
    );

    expect(assessEvidence([source])).toMatchObject({
      points: 0,
      categories: [],
    });
  });

  it("does not replay a verification after the source body changes", () => {
    const source = textSource(
      "COMMENT_EDIT_BINDING",
      [
        "<!-- evidence-row:after-screenshots -->",
        "After screenshot: https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc",
      ].join("\n"),
      actor("author"),
      "body",
    );
    const verification = verifiedSourceEvidence(source);
    const edited = {
      ...source,
      body: `${source.body}\nEdited after verification.`,
    };

    expect(assessEvidence([edited], verification)).toMatchObject({
      points: 0,
      categories: [],
    });
    expect(
      assessEvidence(
        [{ ...source, updatedAt: "2026-07-29T10:01:00.000Z" }],
        verification,
      ),
    ).toMatchObject({ points: 0, categories: [] });
  });

  it("scores the verifier identity for an inline-code artifact URL", () => {
    const source = textSource(
      "COMMENT_INLINE_CODE",
      [
        "<!-- evidence-row:after-screenshots -->",
        "After screenshot: `https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc`",
      ].join("\n"),
      actor("author"),
      "body",
    );

    expect(
      assessEvidence([source], verifiedSourceEvidence(source)),
    ).toMatchObject({
      points: 1,
      categories: ["screenshot"],
    });
  });

  it("does not reuse one artifact as several evidence categories", () => {
    const contextual = textSource(
      "COMMENT_REUSED_CONTEXTUAL_ARTIFACT",
      "Screenshot, video, logs, trajectory, and wallet artifact: https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc",
    );
    const stableRows = textSource(
      "COMMENT_REUSED_STABLE_ARTIFACT",
      [
        "<!-- evidence-row:after-screenshots -->",
        "After screenshot: https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?kind=image",
        "<!-- evidence-row:walkthrough-video -->",
        "Video: https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?kind=video",
      ].join("\n"),
      actor("author"),
      "body",
    );

    expect(
      assessEvidence(
        [contextual, stableRows],
        verifiedSourceEvidence(stableRows),
      ),
    ).toMatchObject({
      points: 0,
      categories: [],
    });
  });
});

describe("outcome qualification", () => {
  it("requires both material additions and churn in non-fixture test files", () => {
    expect(MATERIAL_TEST_ADDITIONS).toBe(10);
    expect(MATERIAL_TEST_CHURN).toBe(20);
    expect(
      hasMaterialTestChange([
        { path: "src/feature.test.ts", additions: 9, deletions: 50 },
      ]),
    ).toBe(false);
    expect(
      hasMaterialTestChange([
        { path: "src/feature.test.ts", additions: 10, deletions: 9 },
      ]),
    ).toBe(false);
    expect(
      hasMaterialTestChange([
        {
          path: "src/__tests__/fixtures/feature.test.ts",
          additions: 100,
          deletions: 100,
        },
      ]),
    ).toBe(false);
    expect(
      hasMaterialTestChange([
        { path: "src/feature.test.ts", additions: 6, deletions: 4 },
        { path: "tests/feature.spec.ts", additions: 4, deletions: 6 },
      ]),
    ).toBe(true);
  });

  it("does not award GitHub's completed state reason without trusted proof", () => {
    const completedOnly = issue({ labels: [] });
    const trustedLabel = issue({
      labels: [{ id: "LABEL_TRIAGED", name: "status: triaged", color: "fff" }],
    });
    const mergedFix = issue({
      labels: [{ id: "LABEL_READY", name: "good first issue", color: "fff" }],
      closedByPullRequests: [
        {
          id: "PR_FIX",
          number: 99,
          url: "https://github.com/elizaOS/eliza/pull/99",
          mergedAt: "2026-07-11T11:00:00.000Z",
          body: "",
          createdAt: "2026-07-10T11:00:00.000Z",
          updatedAt: "2026-07-11T11:00:00.000Z",
          author: actor("fixer"),
        },
      ],
    });
    const notPlanned = issue({
      stateReason: "NOT_PLANNED",
      labels: [{ id: "LABEL_OLD", name: "confirmed", color: "fff" }],
    });

    expect(qualifiesResolvedIssue(completedOnly)).toBe(false);
    expect(qualifiesResolvedIssue(trustedLabel)).toBe(true);
    expect(qualifiesResolvedIssue(mergedFix)).toBe(true);
    expect(qualifiesResolvedIssue(notPlanned)).toBe(false);
  });
});

describe("scoring and caps", () => {
  it("scores accepted outcomes while capping evidence and reviews", () => {
    const reviewer = actor("reviewer");
    const evidenceBody = [
      "<!-- evidence-row:after-screenshots -->",
      "After screenshot: https://github.com/user-attachments/assets/desktop-id",
      "<!-- evidence-row:walkthrough-video -->",
      "Video: https://github.com/user-attachments/assets/video-id",
      "<!-- evidence-row:backend-logs -->",
      "Browser logs: https://github.com/user-attachments/assets/log-id",
      "<!-- evidence-row:llm-trajectory -->",
      "Trajectory: https://github.com/elizaOS/eliza/actions/runs/123/artifacts/456",
      "<!-- evidence-row:domain-artifacts -->",
      "Artifact: https://github.com/elizaOS/eliza/blob/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/evidence/output.json",
    ].join("\n");
    const pr = pullRequest({
      body: [
        machineAttribution("OpenAI", "gpt-5.6-sol", "codex"),
        evidenceBody,
      ].join("\n"),
      files: [
        {
          path: "src/feature.ts",
          additions: 10,
          deletions: 1,
        },
        {
          path: "src/__tests__/feature.test.ts",
          additions: 12,
          deletions: 8,
        },
      ],
      reviews: [
        {
          id: "REVIEW_1",
          body: "The failure path is now covered and the assertion is specific.",
          state: "APPROVED",
          submittedAt: "2026-07-10T11:00:00.000Z",
          url: "https://github.com/elizaOS/eliza/pull/1#pullrequestreview-1",
          author: reviewer,
          inlineCommentCount: 0,
        },
        {
          id: "REVIEW_2",
          body: "A second approval must not add another review award.",
          state: "APPROVED",
          submittedAt: "2026-07-10T11:30:00.000Z",
          url: "https://github.com/elizaOS/eliza/pull/1#pullrequestreview-2",
          author: reviewer,
          inlineCommentCount: 0,
        },
      ],
    });

    const resolved = issue({
      closedByPullRequests: [
        {
          id: "PR_RESOLVER",
          number: 77,
          url: "https://github.com/elizaOS/eliza/pull/77",
          mergedAt: "2026-07-30T10:00:00.000Z",
          body: machineAttribution("OpenAI", "gpt-5.6-sol", "codex"),
          createdAt: "2026-07-29T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
          author: actor("reporter"),
        },
      ],
    });
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [pr, pr],
        resolvedIssues: [resolved, resolved],
        verifiedEvidence: verifiedPullRequestEvidence([pr]),
      }),
    );

    const authorEntry = snapshot.leaders.find(
      (entry) => entry.actor.login === "author",
    );
    const reviewerEntry = snapshot.leaders.find(
      (entry) => entry.actor.login === "reviewer",
    );
    const reporterEntry = snapshot.leaders.find(
      (entry) => entry.actor.login === "reporter",
    );

    expect(authorEntry).toMatchObject({
      score: 20,
      points: {
        mergedPullRequests: 10,
        materialTestChanges: 4,
        evidence: 6,
      },
      reportedModels: ["OpenAI/gpt-5.6-sol"],
    });
    expect(reviewerEntry).toMatchObject({
      score: 3,
      acceptedOutcomes: { substantiveReviews: 1 },
    });
    expect(reporterEntry?.score).toBe(4);
    expect(snapshot.ledger).toHaveLength(9);
  });

  it("excludes bots, self-reviews, and reviews after merge", () => {
    const pullRequestAuthor = actor("author");
    const bot = actor("automation", "Bot");
    const lateReviewer = actor("late");
    const botPullRequest = pullRequest({
      id: "PR_BOT",
      number: 3,
      author: bot,
    });
    const humanPullRequest = pullRequest({
      author: pullRequestAuthor,
      reviews: [
        {
          id: "SELF_REVIEW",
          body: "This is long enough but is still a self review.",
          state: "APPROVED",
          submittedAt: "2026-07-10T11:00:00.000Z",
          url: "https://github.com/elizaOS/eliza/pull/1#self",
          author: pullRequestAuthor,
          inlineCommentCount: 1,
        },
        {
          id: "BOT_REVIEW",
          body: "Automated approval cannot score.",
          state: "APPROVED",
          submittedAt: "2026-07-10T11:00:00.000Z",
          url: "https://github.com/elizaOS/eliza/pull/1#bot",
          author: bot,
          inlineCommentCount: 1,
        },
        {
          id: "LATE_REVIEW",
          body: "This review arrived after the pull request was merged.",
          state: "APPROVED",
          submittedAt: "2026-07-30T11:30:00.000Z",
          url: "https://github.com/elizaOS/eliza/pull/1#late",
          author: lateReviewer,
          inlineCommentCount: 1,
        },
      ],
    });

    const snapshot = createLeaderboardSnapshot(
      input({ mergedPullRequests: [botPullRequest, humanPullRequest] }),
    );

    expect(snapshot.leaders.map((entry) => entry.actor.login)).toEqual([
      "author",
    ]);
    expect(snapshot.ledger.map((event) => event.category)).toEqual([
      "merged-pull-request",
    ]);
  });

  it("scores only evidence that existed unchanged when the pull request merged", () => {
    const commentCopy = textSource(
      "COMMENT_PRE_MERGE_COPY",
      [
        "<!-- evidence-row:walkthrough-video -->",
        "Video: https://github.com/user-attachments/assets/comment-copy",
      ].join("\n"),
    );
    const scoredPullRequest = pullRequest({
      body: [
        "<!-- evidence-row:after-screenshots -->",
        "After screenshot: https://github.com/user-attachments/assets/pre-merge",
      ].join("\n"),
      lastEditedAt: "2026-07-30T10:00:00.000Z",
      comments: [commentCopy],
    });
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [scoredPullRequest],
        verifiedEvidence: [
          ...verifiedPullRequestEvidence([scoredPullRequest]),
          ...verifiedSourceEvidence(commentCopy),
        ],
      }),
    );

    expect(snapshot.leaders[0]).toMatchObject({
      score: 11,
      points: { mergedPullRequests: 10, evidence: 1 },
      acceptedOutcomes: { evidenceCategories: 1 },
    });
    expect(
      snapshot.ledger
        .filter((event) => event.category === "evidence")
        .map((event) => event.reason),
    ).toEqual([
      "Remote screenshot evidence passed byte and structure verification.",
    ]);
  });

  it("keeps model disclosure non-scoring", () => {
    const withoutDisclosure = createLeaderboardSnapshot(
      input({ mergedPullRequests: [pullRequest()] }),
    );
    const withDisclosure = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [
          pullRequest({
            body: machineAttribution("Anthropic", "claude-opus-4-1"),
          }),
        ],
      }),
    );

    expect(withDisclosure.leaders[0].score).toBe(
      withoutDisclosure.leaders[0].score,
    );
  });

  it("orders tied GitHub logins by locale-independent code units", () => {
    const pullRequests = ["Zed", "aa", "a0", "a-b"].map((login, index) =>
      pullRequest({
        id: `PR_TIE_${index}`,
        number: 500 + index,
        author: actor(login),
      }),
    );
    const forward = createLeaderboardSnapshot(
      input({ mergedPullRequests: pullRequests }),
    );
    const reversed = createLeaderboardSnapshot(
      input({ mergedPullRequests: [...pullRequests].reverse() }),
    );

    expect(forward.leaders.map((entry) => entry.actor.login)).toEqual([
      "a-b",
      "a0",
      "aa",
      "Zed",
    ]);
    expect(reversed.leaders).toEqual(forward.leaders);
  });

  it("applies every contributor cap newest-first and independently of input order", () => {
    const contributor = actor("cap-author");
    const reviewer = actor("cap-reviewer");
    const richPullRequests = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      const body = [
        machineAttribution("OpenAI", `gpt-5.${number}`),
        "<!-- evidence-row:after-screenshots -->",
        `After screenshot: https://github.com/user-attachments/assets/screenshot-${number}`,
        "<!-- evidence-row:walkthrough-video -->",
        `Video: https://github.com/user-attachments/assets/video-${number}`,
        "<!-- evidence-row:backend-logs -->",
        `Logs: https://github.com/elizaOS/eliza/actions/runs/${number}/artifacts/${number}`,
        "<!-- evidence-row:llm-trajectory -->",
        `Trajectory: https://github.com/elizaOS/eliza/actions/runs/${number}/artifacts/${number + 100}`,
        "<!-- evidence-row:domain-artifacts -->",
        `Artifact: https://github.com/elizaOS/eliza/blob/${"a".repeat(40)}/evidence/${number}.json`,
      ].join("\n");
      return pullRequest({
        id: `PR_CAP_${number}`,
        number,
        title: `Capped pull request ${number}`,
        body,
        createdAt: "2026-07-30T09:00:00.000Z",
        updatedAt: "2026-07-30T11:00:00.000Z",
        mergedAt: "2026-07-30T11:00:00.000Z",
        author: contributor,
        files: [
          {
            path: `src/feature-${number}.test.ts`,
            additions: 12,
            deletions: 8,
          },
        ],
        reviews: [
          {
            id: `REVIEW_CAP_${number}`,
            body: "The failure path and verification assertions are specific.",
            state: "APPROVED",
            submittedAt: "2026-07-30T10:00:00.000Z",
            url: `https://github.com/elizaOS/eliza/pull/${number}#pullrequestreview-${number}`,
            author: reviewer,
            inlineCommentCount: 0,
          },
        ],
      });
    });
    const resolvedIssues = Array.from({ length: 7 }, (_, index) => {
      const number = 101 + index;
      return issue({
        id: `ISSUE_CAP_${number}`,
        number,
        title: `Resolved issue ${number}`,
        author: actor(`reporter-${number}`),
        closedByPullRequests: [
          {
            id: `PR_RESOLVER_${number}`,
            number: number + 1_000,
            url: `https://github.com/elizaOS/eliza/pull/${number + 1_000}`,
            mergedAt: "2026-07-30T10:00:00.000Z",
            body: "",
            createdAt: "2026-07-30T09:00:00.000Z",
            updatedAt: "2026-07-30T10:00:00.000Z",
            author: contributor,
          },
        ],
      });
    });
    const verifiedEvidence = verifiedPullRequestEvidence(richPullRequests);
    const forward = createLeaderboardSnapshot(
      input({
        mergedPullRequests: richPullRequests,
        resolvedIssues,
        verifiedEvidence,
      }),
    );
    const reversed = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [...richPullRequests].reverse(),
        resolvedIssues: [...resolvedIssues].reverse(),
        verifiedEvidence,
      }),
    );

    expect(reversed).toEqual(forward);
    expect(
      forward.leaders.find((entry) => entry.actor.id === contributor.id),
    ).toMatchObject({
      score: 120,
      acceptedOutcomes: {
        mergedPullRequests: SCORE_CAPS.mergedPullRequests,
        resolvedIssues: SCORE_CAPS.resolvedIssues,
        materialTestChanges: SCORE_CAPS.materialTestChanges,
        evidenceCategories: 25,
      },
      points: {
        mergedPullRequests: 50,
        resolvedIssues: 20,
        materialTestChanges: 20,
        evidence: SCORE_CAPS.evidencePoints,
      },
      reportedModels: [
        "OpenAI/gpt-5.10",
        "OpenAI/gpt-5.11",
        "OpenAI/gpt-5.12",
        "OpenAI/gpt-5.8",
        "OpenAI/gpt-5.9",
      ],
    });
    expect(
      forward.leaders.find((entry) => entry.actor.id === reviewer.id),
    ).toMatchObject({
      score: 30,
      acceptedOutcomes: {
        substantiveReviews: SCORE_CAPS.substantiveReviews,
      },
    });
    expect(
      forward.ledger
        .filter((event) => event.category === "merged-pull-request")
        .map((event) => event.source.number)
        .sort((left, right) => right - left),
    ).toEqual([12, 11, 10, 9, 8]);
    expect(
      forward.ledger
        .filter((event) => event.category === "resolved-issue")
        .map((event) => event.source.number)
        .sort((left, right) => right - left),
    ).toEqual([107, 106, 105, 104, 103]);
  });

  it("awards a canonical artifact to only its first merged pull request", () => {
    const sharedUrl =
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence/shared.log";
    const first = pullRequest({
      id: "PR_FIRST_SHARED_EVIDENCE",
      number: 50,
      author: actor("first-evidence-author"),
      mergedAt: "2026-07-29T11:00:00.000Z",
      body: `<!-- evidence-row:backend-logs -->\nLogs: ${sharedUrl}`,
    });
    const later = pullRequest({
      id: "PR_LATER_SHARED_EVIDENCE",
      number: 51,
      author: actor("later-evidence-author"),
      mergedAt: "2026-07-30T11:00:00.000Z",
      body: `<!-- evidence-row:backend-logs -->\nLogs: ${sharedUrl}`,
    });
    const verifiedEvidence = verifiedPullRequestEvidence([first, later]).map(
      (artifact) => ({
        ...artifact,
        contentSha256: "c".repeat(64),
      }),
    );

    const snapshot = createLeaderboardSnapshot(
      input({ mergedPullRequests: [later, first], verifiedEvidence }),
    );

    expect(
      snapshot.leaders.find(
        (entry) => entry.actor.login === "first-evidence-author",
      )?.points.evidence,
    ).toBe(1);
    expect(
      snapshot.leaders.find(
        (entry) => entry.actor.login === "later-evidence-author",
      )?.points.evidence,
    ).toBe(0);
    expect(
      snapshot.ledger.filter((event) => event.category === "evidence"),
    ).toHaveLength(1);
  });

  it("scores evidence only for the contribution author", () => {
    const contributor = actor("evidence-author");
    const thirdParty = actor("evidence-bystander");
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [
          pullRequest({
            author: contributor,
            comments: [
              {
                ...textSource(
                  "COMMENT_THIRD_PARTY_EVIDENCE",
                  [
                    "<!-- evidence-row:after-screenshots -->",
                    "After screenshot: https://github.com/user-attachments/assets/third-party",
                  ].join("\n"),
                  thirdParty,
                ),
                artifactId: "PR_1",
              },
            ],
          }),
        ],
      }),
    );

    expect(snapshot.leaders).toHaveLength(1);
    expect(snapshot.leaders[0]).toMatchObject({
      actor: { login: "evidence-author" },
      score: 10,
      points: { evidence: 0 },
    });
    expect(snapshot.ledger.some((event) => event.category === "evidence")).toBe(
      false,
    );
  });

  it("attributes issue resolution to the merged fixer rather than the reporter", () => {
    const reporter = actor("issue-reporter");
    const fixer = actor("issue-fixer");
    const snapshot = createLeaderboardSnapshot(
      input({
        resolvedIssues: [
          issue({
            author: reporter,
            closedByPullRequests: [
              {
                id: "PR_ISSUE_FIX",
                number: 99,
                url: "https://github.com/elizaOS/eliza/pull/99",
                mergedAt: "2026-07-30T10:00:00.000Z",
                body: machineAttribution("OpenAI", "gpt-5.6-sol"),
                createdAt: "2026-07-29T10:00:00.000Z",
                updatedAt: "2026-07-30T10:00:00.000Z",
                author: fixer,
              },
            ],
          }),
        ],
      }),
    );

    expect(snapshot.leaders.map((entry) => entry.actor.login)).toEqual([
      "issue-fixer",
    ]);
    expect(snapshot.leaders[0].points.resolvedIssues).toBe(4);
    expect(
      snapshot.ledger.find((event) => event.category === "resolved-issue")?.id,
    ).toBe("ISSUE_1:resolved-by:PR_ISSUE_FIX");
    expect(snapshot.attributions[0]).toMatchObject({
      artifactId: "PR_ISSUE_FIX",
      actor: fixer,
      identifier: "openai/gpt-5.6-sol",
    });
  });

  it("does not attach unrelated open-work attribution to a scored leader", () => {
    const contributor = actor("scored-author");
    const unrelated = issue({
      id: "ISSUE_UNRELATED_MODEL",
      number: 88,
      closedAt: null,
      stateReason: null,
      labels: [{ id: "LABEL_READY", name: "help wanted", color: "fff" }],
      comments: [
        {
          ...textSource(
            "COMMENT_UNRELATED_MODEL",
            machineAttribution("Anthropic", "claude-opus-4-1"),
            contributor,
          ),
          artifactId: "ISSUE_UNRELATED_MODEL",
          url: "https://github.com/elizaOS/eliza/issues/88#issuecomment-88",
        },
      ],
    });
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [pullRequest({ author: contributor })],
        openIssues: [unrelated],
      }),
    );

    expect(snapshot.leaders[0].reportedModels).toEqual([]);
    expect(snapshot.attributions).toEqual([]);
  });
});

describe("work queue claims and prioritization", () => {
  it("marks only safe, unclaimed issue and review candidates", () => {
    const issueCandidate = issue({
      id: "ISSUE_CANDIDATE",
      number: 1,
      closedAt: null,
      stateReason: null,
      labels: [{ id: "LABEL_READY", name: "good first issue", color: "fff" }],
    });
    const claimedIssue = issue({
      id: "ISSUE_LANE_CLAIM",
      number: 2,
      closedAt: null,
      stateReason: null,
      labels: [
        { id: "LABEL_READY_2", name: "help wanted", color: "fff" },
        {
          id: "LABEL_LANE_CLAIM",
          name: "claimed:shaw-codex",
          color: "fff",
        },
      ],
    });
    const sensitiveIssue = issue({
      id: "ISSUE_SECURITY",
      number: 3,
      closedAt: null,
      stateReason: null,
      labels: [
        { id: "LABEL_READY_3", name: "triage-reviewed", color: "fff" },
        { id: "LABEL_SECURITY", name: "security", color: "fff" },
      ],
    });
    const botIssue = issue({
      id: "ISSUE_BOT",
      number: 4,
      closedAt: null,
      stateReason: null,
      labels: [{ id: "LABEL_READY_4", name: "help wanted", color: "fff" }],
      author: actor("renovate"),
    });
    const untriagedIssue = issue({
      id: "ISSUE_UNTRIAGED",
      number: 5,
      closedAt: null,
      stateReason: null,
      labels: [],
    });
    const humanGatedIssue = issue({
      id: "ISSUE_HUMAN_GATED",
      number: 6,
      closedAt: null,
      stateReason: null,
      labels: [
        { id: "LABEL_READY_6", name: "triage-reviewed", color: "fff" },
        {
          id: "LABEL_HUMAN",
          name: "status: needs-human-verify",
          color: "fff",
        },
      ],
    });
    const epicIssue = issue({
      id: "ISSUE_EPIC",
      number: 7,
      title: "[Epic] Replace the entire delivery stack",
      closedAt: null,
      stateReason: null,
      labels: [{ id: "LABEL_READY_7", name: "triage-reviewed", color: "fff" }],
    });
    const epicLabelIssue = issue({
      id: "ISSUE_EPIC_LABEL",
      number: 8,
      title: "Replace the second delivery stack",
      closedAt: null,
      stateReason: null,
      labels: [
        { id: "LABEL_READY_8", name: "triage-reviewed", color: "fff" },
        { id: "LABEL_EPIC_8", name: "Epic 4", color: "fff" },
      ],
    });
    const reviewCandidate = pullRequest({
      id: "PR_CANDIDATE",
      number: 10,
      mergedAt: null,
      reviewDecision: null,
    });
    const requestedReview = pullRequest({
      id: "PR_REQUESTED",
      number: 11,
      mergedAt: null,
      reviewDecision: "REVIEW_REQUIRED",
      activeReviewRequestCount: 2,
    });
    const approvedReview = pullRequest({
      id: "PR_APPROVED",
      number: 12,
      mergedAt: null,
      reviewDecision: "APPROVED",
    });
    const blockedReview = pullRequest({
      id: "PR_BLOCKED",
      number: 13,
      mergedAt: null,
      reviewDecision: null,
      labels: [{ id: "LABEL_BLOCKED", name: "blocked", color: "fff" }],
    });
    const claimedReview = pullRequest({
      id: "PR_LANE_CLAIM",
      number: 14,
      mergedAt: null,
      reviewDecision: null,
      labels: [
        {
          id: "LABEL_REVIEW_LANE_CLAIM",
          name: "review-claimed:review-lane",
          color: "fff",
        },
      ],
    });

    const snapshot = createLeaderboardSnapshot(
      input({
        openIssues: [
          issueCandidate,
          claimedIssue,
          sensitiveIssue,
          botIssue,
          untriagedIssue,
          humanGatedIssue,
          epicIssue,
          epicLabelIssue,
        ],
        openPullRequests: [
          reviewCandidate,
          requestedReview,
          approvedReview,
          blockedReview,
          claimedReview,
        ],
      }),
    );
    const selections = new Map(
      [...snapshot.workQueue.issues, ...snapshot.workQueue.pullRequests].map(
        (item) => [item.id, item.selection],
      ),
    );

    expect(selections.get("ISSUE_CANDIDATE")).toEqual({
      status: "candidate",
      reasons: [],
    });
    expect(selections.get("PR_CANDIDATE")).toEqual({
      status: "candidate",
      reasons: [],
    });
    expect(selections.get("ISSUE_LANE_CLAIM")?.reasons).toEqual(["claimed"]);
    expect(selections.get("ISSUE_SECURITY")?.reasons).toEqual([
      "security-sensitive",
    ]);
    expect(selections.get("ISSUE_BOT")?.reasons).toEqual(["bot-authored"]);
    expect(selections.get("ISSUE_UNTRIAGED")?.reasons).toEqual(["untriaged"]);
    expect(selections.get("ISSUE_HUMAN_GATED")?.reasons).toEqual(["blocked"]);
    expect(selections.get("ISSUE_EPIC")?.reasons).toEqual(["untriaged"]);
    expect(selections.get("ISSUE_EPIC_LABEL")?.reasons).toEqual(["untriaged"]);
    expect(selections.get("PR_REQUESTED")?.reasons).toEqual([
      "active-review-request",
    ]);
    expect(selections.get("PR_APPROVED")?.reasons).toEqual([
      "already-approved",
    ]);
    expect(selections.get("PR_BLOCKED")?.reasons).toEqual(["blocked"]);
    expect(selections.get("PR_LANE_CLAIM")?.reasons).toEqual(["claimed"]);
  });

  it("normalizes every shared claim and blocked label spelling", () => {
    for (const [index, name] of [
      "status:in-progress",
      "status: in-progress",
      "status:claimed",
      "status: claimed",
      "claimed:lane-one",
    ].entries()) {
      const snapshot = createLeaderboardSnapshot(
        input({
          openIssues: [
            issue({
              id: `ISSUE_LABEL_${index}`,
              number: 100 + index,
              closedAt: null,
              stateReason: null,
              labels: [{ id: `LABEL_${index}`, name, color: "fff" }],
            }),
          ],
        }),
      );
      expect(snapshot.workQueue.issues[0].selection.reasons).toContain(
        "claimed",
      );
    }

    for (const [index, name] of [
      "review:claimed",
      "review: claimed",
      "review-in-progress:lane-one",
    ].entries()) {
      const snapshot = createLeaderboardSnapshot(
        input({
          openPullRequests: [
            pullRequest({
              id: `PR_LABEL_${index}`,
              number: 200 + index,
              mergedAt: null,
              reviewDecision: null,
              labels: [{ id: `REVIEW_LABEL_${index}`, name, color: "fff" }],
            }),
          ],
        }),
      );
      expect(snapshot.workQueue.pullRequests[0].selection.reasons).toContain(
        "claimed",
      );
    }

    for (const [index, name] of [
      "status:blocked",
      "status: blocked",
      "status/proposal",
      "do-not-merge",
      "needs-human-verification",
      "status: needs-human-verify",
      "needs-shaw",
    ].entries()) {
      const snapshot = createLeaderboardSnapshot(
        input({
          openIssues: [
            issue({
              id: `ISSUE_BLOCKED_${index}`,
              number: 300 + index,
              closedAt: null,
              stateReason: null,
              labels: [
                {
                  id: `READY_LABEL_${index}`,
                  name: "help wanted",
                  color: "fff",
                },
                { id: `BLOCKED_LABEL_${index}`, name, color: "fff" },
              ],
            }),
          ],
        }),
      );
      expect(snapshot.workQueue.issues[0]).toMatchObject({
        actionability: "blocked",
        selection: { reasons: ["blocked"] },
      });
    }
  });

  it("uses recent claim comments and never treats a PR author as its reviewer", () => {
    const issueClaimant = actor("issue-claimant");
    const reviewer = actor("review-claimant");
    const recentIssue = issue({
      id: "ISSUE_RECENT",
      number: 10,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_ISSUE_CLAIM",
            "CLAIMING: reproduce and finish the scheduler fix",
            issueClaimant,
          ),
          artifactId: "ISSUE_RECENT",
          createdAt: "2026-07-29T10:00:00.000Z",
        },
      ],
    });
    const staleIssue = issue({
      id: "ISSUE_STALE",
      number: 11,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_STALE_CLAIM",
            "CLAIMING: an abandoned attempt",
            actor("stale-claimant"),
          ),
          artifactId: "ISSUE_STALE",
          createdAt: "2026-07-20T10:00:00.000Z",
        },
      ],
    });
    const fencedExampleIssue = issue({
      id: "ISSUE_FENCED_EXAMPLE",
      number: 12,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_FENCED_ISSUE_CLAIM",
            "````text\nCLAIMING: example only\n```\n````",
            actor("example-author"),
          ),
          artifactId: "ISSUE_FENCED_EXAMPLE",
          createdAt: "2026-07-29T10:00:00.000Z",
        },
      ],
    });
    const unknownClaimIssue = issue({
      id: "ISSUE_UNKNOWN_CLAIM",
      number: 13,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_UNKNOWN_CLAIM",
            "CLAIMING: deleted authors cannot reserve work",
          ),
          artifactId: "ISSUE_UNKNOWN_CLAIM",
          author: null,
        },
      ],
    });
    const spacedMarkerIssue = issue({
      id: "ISSUE_SPACED_MARKER",
      number: 14,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_SPACED_MARKER",
            "CLAIMING : noncanonical marker",
          ),
          artifactId: "ISSUE_SPACED_MARKER",
        },
      ],
    });
    const openPullRequest = pullRequest({
      id: "PR_REVIEW",
      number: 20,
      mergedAt: null,
      comments: [
        {
          ...textSource(
            "COMMENT_AUTHOR_REVIEW_CLAIM",
            "CLAIMING REVIEW: my own pull request",
            actor("author"),
          ),
          artifactId: "PR_REVIEW",
          createdAt: "2026-07-29T12:00:00.000Z",
        },
        {
          ...textSource(
            "COMMENT_REVIEW_CLAIM",
            "CLAIMING REVIEW: independent validation and repair",
            reviewer,
          ),
          artifactId: "PR_REVIEW",
          createdAt: "2026-07-29T11:00:00.000Z",
        },
        {
          ...textSource(
            "COMMENT_FENCED_REVIEW_CLAIM",
            ["```text", "CLAIMING REVIEW: example only", "```"].join("\n"),
            reviewer,
          ),
          artifactId: "PR_WRONG_FORM",
          createdAt: "2026-07-29T11:30:00.000Z",
        },
      ],
    });
    const wrongClaimForm = pullRequest({
      id: "PR_WRONG_FORM",
      number: 21,
      mergedAt: null,
      comments: [
        {
          ...textSource(
            "COMMENT_WRONG_FORM",
            "CLAIMING: implementation work does not claim the review lane",
            reviewer,
          ),
          artifactId: "PR_WRONG_FORM",
          createdAt: "2026-07-29T11:00:00.000Z",
        },
      ],
    });

    const snapshot = createLeaderboardSnapshot(
      input({
        openIssues: [
          recentIssue,
          staleIssue,
          fencedExampleIssue,
          unknownClaimIssue,
          spacedMarkerIssue,
        ],
        openPullRequests: [openPullRequest, wrongClaimForm],
      }),
    );
    const recentClaim = snapshot.workQueue.issues.find(
      (item) => item.id === "ISSUE_RECENT",
    )?.claim;
    const staleClaim = snapshot.workQueue.issues.find(
      (item) => item.id === "ISSUE_STALE",
    )?.claim;
    const fencedExampleClaim = snapshot.workQueue.issues.find(
      (item) => item.id === "ISSUE_FENCED_EXAMPLE",
    )?.claim;
    const unknownClaim = snapshot.workQueue.issues.find(
      (item) => item.id === "ISSUE_UNKNOWN_CLAIM",
    )?.claim;
    const spacedMarkerClaim = snapshot.workQueue.issues.find(
      (item) => item.id === "ISSUE_SPACED_MARKER",
    )?.claim;
    const reviewClaim = snapshot.workQueue.pullRequests.find(
      (item) => item.id === "PR_REVIEW",
    )?.claim;
    const implementationOnly = snapshot.workQueue.pullRequests.find(
      (item) => item.id === "PR_WRONG_FORM",
    )?.claim;

    expect(recentClaim).toMatchObject({
      status: "claimed",
      source: "claim-comment",
      kind: "implementation",
      actors: [expect.objectContaining({ login: "issue-claimant" })],
      claimedAt: "2026-07-29T10:00:00.000Z",
    });
    expect(staleClaim).toMatchObject({
      status: "unclaimed",
      source: "none",
      kind: null,
    });
    expect(fencedExampleClaim).toMatchObject({
      status: "unclaimed",
      source: "none",
      kind: null,
    });
    expect(unknownClaim?.status).toBe("unclaimed");
    expect(spacedMarkerClaim?.status).toBe("unclaimed");
    expect(reviewClaim).toMatchObject({
      status: "claimed",
      source: "claim-comment",
      kind: "review",
      actors: [expect.objectContaining({ login: "review-claimant" })],
    });
    expect(implementationOnly?.status).toBe("unclaimed");
  });

  it("lets only trusted repository participants reserve work with comments", () => {
    const readyLabel = { id: "LABEL_READY", name: "help wanted", color: "fff" };
    const untrusted = issue({
      id: "ISSUE_UNTRUSTED_CLAIM",
      number: 18,
      closedAt: null,
      stateReason: null,
      labels: [readyLabel],
      comments: [
        {
          ...textSource(
            "COMMENT_UNTRUSTED_CLAIM",
            "CLAIMING: an outsider cannot reserve this issue",
            actor("outside-visitor"),
          ),
          artifactId: "ISSUE_UNTRUSTED_CLAIM",
          authorAssociation: "NONE",
        },
      ],
    });
    const trusted = issue({
      id: "ISSUE_TRUSTED_CLAIM",
      number: 19,
      closedAt: null,
      stateReason: null,
      labels: [readyLabel],
      comments: [
        {
          ...textSource(
            "COMMENT_TRUSTED_CLAIM",
            "CLAIMING: a collaborator reserved this issue",
            actor("repository-collaborator"),
          ),
          artifactId: "ISSUE_TRUSTED_CLAIM",
          authorAssociation: "COLLABORATOR",
        },
      ],
    });
    const snapshot = createLeaderboardSnapshot(
      input({ openIssues: [untrusted, trusted] }),
    );
    const untrustedItem = snapshot.workQueue.issues.find(
      (item) => item.id === untrusted.id,
    );
    const trustedItem = snapshot.workQueue.issues.find(
      (item) => item.id === trusted.id,
    );

    expect(untrustedItem).toMatchObject({
      claim: { status: "unclaimed" },
      selection: { status: "candidate", reasons: [] },
    });
    expect(trustedItem).toMatchObject({
      claim: { status: "claimed" },
      selection: { status: "excluded", reasons: ["claimed"] },
    });
  });

  it("recognizes claims collected after the scoring cutoff", () => {
    const generatedAt = "2026-07-30T12:05:00.000Z";
    const duringCollection = issue({
      id: "ISSUE_DURING_COLLECTION",
      number: 22,
      closedAt: null,
      stateReason: null,
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_DURING_COLLECTION",
            "CLAIMING: work claimed while the snapshot was collecting",
            actor("active-claimant"),
          ),
          artifactId: "ISSUE_DURING_COLLECTION",
          createdAt: "2026-07-30T12:03:00.000Z",
          updatedAt: "2026-07-30T12:03:00.000Z",
        },
      ],
    });
    const lateInput = input({
      generatedAt,
      openIssues: [duringCollection],
    });
    lateInput.source.fetchedAt = generatedAt;

    const snapshot = createLeaderboardSnapshot(lateInput);

    expect(snapshot.workQueue.issues[0].claim).toMatchObject({
      status: "claimed",
      source: "claim-comment",
      actors: [expect.objectContaining({ login: "active-claimant" })],
    });
    expect(snapshot.workQueue.issues[0].selection.reasons).toContain("claimed");
  });

  it("sorts actionable unclaimed work before claims, blocks, and drafts", () => {
    const unclaimed = pullRequest({
      id: "PR_UNCLAIMED",
      number: 30,
      mergedAt: null,
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
      labels: [{ id: "LABEL_LOW", name: "priority: low", color: "fff" }],
    });
    const claimed = pullRequest({
      id: "PR_CLAIMED",
      number: 31,
      mergedAt: null,
      updatedAt: "2026-07-29T12:00:00.000Z",
      labels: [{ id: "LABEL_CLAIMED", name: "review-claimed", color: "fff" }],
    });
    const blocked = pullRequest({
      id: "PR_BLOCKED",
      number: 32,
      mergedAt: null,
      updatedAt: "2026-07-30T11:00:00.000Z",
      labels: [
        { id: "LABEL_BLOCKED", name: "status: blocked", color: "fff" },
        { id: "LABEL_P0", name: "p0", color: "fff" },
      ],
    });
    const draft = pullRequest({
      id: "PR_DRAFT",
      number: 33,
      mergedAt: null,
      isDraft: true,
      updatedAt: "2026-07-30T11:30:00.000Z",
      labels: [{ id: "LABEL_URGENT", name: "urgent", color: "fff" }],
    });

    const queue = createLeaderboardSnapshot(
      input({ openPullRequests: [draft, blocked, claimed, unclaimed] }),
    ).workQueue.pullRequests;

    expect(queue.map((item) => item.id)).toEqual([
      "PR_UNCLAIMED",
      "PR_CLAIMED",
      "PR_BLOCKED",
      "PR_DRAFT",
    ]);
    expect(queue.map((item) => item.actionability)).toEqual([
      "actionable",
      "actionable",
      "blocked",
      "draft",
    ]);
    expect(queue.map((item) => item.priority)).toEqual([
      "low",
      "normal",
      "urgent",
      "urgent",
    ]);
  });

  it("reports verified open-PR evidence without awarding points", () => {
    const openPullRequest = pullRequest({
      id: "PR_OPEN_VERIFIED_EVIDENCE",
      number: 44,
      mergedAt: null,
      body: [
        "<!-- evidence-row:after-screenshots -->",
        "After screenshot: https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc",
      ].join("\n"),
    });
    const source = pullRequestTextSources(openPullRequest)[0];
    const snapshot = createLeaderboardSnapshot(
      input({
        openPullRequests: [openPullRequest],
        verifiedEvidence: verifiedSourceEvidence(
          source,
          null,
          openPullRequest.updatedAt,
        ),
      }),
    );

    expect(snapshot.workQueue.pullRequests[0].evidence).toMatchObject({
      status: "partial",
      points: 1,
      categories: ["screenshot"],
    });
    expect(snapshot.ledger).toEqual([]);
  });

  it("does not let a comment copy satisfy an open PR evidence gap", () => {
    const openPullRequest = pullRequest({
      id: "PR_OPEN_COMMENT_EVIDENCE",
      number: 45,
      mergedAt: null,
    });
    const comment = {
      ...textSource(
        "COMMENT_OPEN_EVIDENCE_COPY",
        [
          "<!-- evidence-row:after-screenshots -->",
          "After screenshot: https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc",
        ].join("\n"),
      ),
      artifactId: openPullRequest.id,
    };
    openPullRequest.comments = [comment];
    const snapshot = createLeaderboardSnapshot(
      input({
        openPullRequests: [openPullRequest],
        verifiedEvidence: verifiedSourceEvidence(
          comment,
          null,
          openPullRequest.updatedAt,
        ),
      }),
    );

    expect(snapshot.workQueue.pullRequests[0].evidence).toMatchObject({
      status: "missing",
      points: 0,
      categories: [],
    });
    expect(snapshot.ledger).toEqual([]);
  });

  it("excludes ordinary discussion from work-item attribution coverage", () => {
    const openIssue = issue({
      id: "ISSUE_COVERAGE",
      closedAt: null,
      stateReason: null,
      body: "AI provider/model: OpenAI / gpt-5.6-sol",
      labels: [],
      comments: [
        {
          ...textSource(
            "COMMENT_WITHOUT_ATTRIBUTION",
            "The reproduced failure still occurs on the empty-input path.",
            actor("second-contributor"),
          ),
          artifactId: "ISSUE_COVERAGE",
          createdAt: "2026-07-29T11:00:00.000Z",
        },
      ],
    });

    const snapshot = createLeaderboardSnapshot(
      input({ openIssues: [openIssue] }),
    );

    expect(snapshot.workQueue.issues[0].model).toMatchObject({
      status: "complete",
      eligibleSourceCount: 1,
      validSourceCount: 1,
      missingSourceCount: 0,
      invalidSourceCount: 0,
    });
    expect(snapshot.attributionCoverage).toMatchObject({
      status: "missing",
      eligibleSourceCount: 0,
      validSourceCount: 0,
    });
    expect(snapshot.leaders).toEqual([]);
  });
});

describe("deduplication and public schema", () => {
  it("deduplicates immutable node IDs in first-seen order", () => {
    expect(
      dedupeByNodeId([
        { id: "NODE_1", value: "first" },
        { id: "NODE_2", value: "second" },
        { id: "NODE_1", value: "duplicate" },
      ]),
    ).toEqual([
      { id: "NODE_1", value: "first" },
      { id: "NODE_2", value: "second" },
    ]);
  });

  it("publishes a valid, repository-scoped and transparent snapshot", () => {
    const snapshot = createLeaderboardSnapshot(
      input({
        openIssues: [issue({ closedAt: null, stateReason: null })],
        openPullRequests: [pullRequest({ mergedAt: null })],
      }),
    );

    expect(() => assertLeaderboardSnapshot(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      repository: LEADERBOARD_REPOSITORY,
      ruleVersion: SCORE_RULE_VERSION,
      stale: false,
      source: {
        provider: "github-graphql",
        counts: { openIssues: 1, openPullRequests: 1 },
      },
    });
    expect(snapshot.methodology.scoringRules).toHaveLength(5);
    expect(snapshot.methodology.nonScoringActivity).toContain(
      "model disclosure",
    );
    expect(snapshot.methodology.materialTestThreshold).toMatchObject({
      minimumAdditions: 10,
      minimumTotalChurn: 20,
    });
    expect(snapshot.workQueue.issues[0]).toHaveProperty("claim.status");
    expect(snapshot.workQueue.issues[0]).toHaveProperty("evidence.status");
    expect(snapshot.workQueue.issues[0]).toHaveProperty("model.status");
  });

  it("keeps outcome and verification coverage explicit and non-overlapping", () => {
    const detail = pullRequest();
    if (!detail.mergedAt) {
      throw new Error("Test merged pull request must have mergedAt");
    }
    const outcome = {
      id: detail.id,
      number: detail.number,
      title: detail.title,
      url: detail.url,
      body: detail.body,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      mergedAt: detail.mergedAt,
      author: detail.author,
      additions: detail.additions,
      deletions: detail.deletions,
    };
    const outcomeOnly = createLeaderboardSnapshot(
      input({
        mergedPullRequestOutcomes: [outcome],
        mergedPullRequests: [],
      }),
    );

    expect(outcomeOnly.source.counts).toMatchObject({
      mergedPullRequests: 1,
      detailedMergedPullRequests: 0,
    });
    expect(outcomeOnly.ledger.map((event) => event.category)).toEqual([
      "merged-pull-request",
    ]);
    expect(() =>
      createLeaderboardSnapshot(
        input({
          mergedPullRequestOutcomes: [],
          mergedPullRequests: [detail],
        }),
      ),
    ).toThrow("missing from the complete outcome window");
    expect(() =>
      createLeaderboardSnapshot(
        input({
          mergedPullRequestOutcomes: [
            { ...outcome, mergedAt: "2026-07-22T12:00:00.000Z" },
          ],
          mergedPullRequests: [
            { ...detail, mergedAt: "2026-07-22T12:00:00.000Z" },
          ],
        }),
      ),
    ).toThrow("falls outside the verification window");
  });

  it("rejects a fabricated healthy snapshot for another repository", () => {
    const snapshot = createLeaderboardSnapshot(input());
    const malformed: unknown = { ...snapshot, repository: "someone/else" };

    expect(() => assertLeaderboardSnapshot(malformed)).toThrow(
      `snapshot.repository must be ${LEADERBOARD_REPOSITORY}`,
    );
  });

  it("rejects phishing URLs and actor identity drift at the read boundary", () => {
    const snapshot = createLeaderboardSnapshot(
      input({ mergedPullRequests: [pullRequest()] }),
    );
    const phishing = structuredClone(snapshot);
    phishing.leaders[0].actor.url = "https://evil.example/author";
    const future = structuredClone(snapshot);
    future.generatedAt = "2100-01-01T00:00:00.000Z";
    future.source.fetchedAt = future.generatedAt;
    const identityDrift = structuredClone(snapshot);
    identityDrift.ledger[0].actor = {
      ...actor("impostor"),
      id: identityDrift.leaders[0].actor.id,
    };

    expect(() => assertLeaderboardSnapshot(phishing)).toThrow(
      "canonical GitHub profile",
    );
    expect(() => assertLeaderboardSnapshot(future)).not.toThrow();
    expect(() =>
      assertPublishableLeaderboardSnapshot(future, Date.parse(NOW)),
    ).toThrow("cannot be in the future");
    expect(() => assertLeaderboardSnapshot(identityDrift)).toThrow(
      "changes identity inside the snapshot",
    );
  });

  it("rejects leader arrays whose ranks disguise the published ordering", () => {
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [
          pullRequest({ id: "PR_ALPHA", number: 40, author: actor("alpha") }),
          pullRequest({
            id: "PR_BETA",
            number: 41,
            author: actor("beta"),
            files: [
              {
                path: "src/beta.test.ts",
                additions: 12,
                deletions: 8,
              },
            ],
          }),
        ],
      }),
    );
    const disguised = structuredClone(snapshot);
    disguised.leaders.reverse();
    disguised.leaders.forEach((leader, index) => {
      leader.rank = index + 1;
    });

    expect(() => assertLeaderboardSnapshot(disguised)).toThrow(
      "must follow the published rank ordering",
    );
  });

  it("rejects internally inconsistent scores and attribution coverage", () => {
    const snapshot = createLeaderboardSnapshot(
      input({ mergedPullRequests: [pullRequest()] }),
    );
    const badScore = structuredClone(snapshot);
    badScore.leaders[0].score += 1;
    const badCoverage = structuredClone(snapshot);
    badCoverage.attributionCoverage.validSourceCount = 1;
    const badModels = structuredClone(snapshot);
    badModels.leaders[0].reportedModels = ["openai/unreported-model"];

    expect(() => assertLeaderboardSnapshot(badScore)).toThrow(
      "score does not equal its point breakdown",
    );
    expect(() => assertLeaderboardSnapshot(badCoverage)).toThrow(
      "source counts are internally inconsistent",
    );
    expect(() => assertLeaderboardSnapshot(badModels)).toThrow(
      "has untraceable reported models",
    );
  });

  it("rejects leader points that cannot be traced to the public ledger", () => {
    const snapshot = createLeaderboardSnapshot(
      input({ mergedPullRequests: [pullRequest()] }),
    );
    const missingLedger = structuredClone(snapshot);
    missingLedger.ledger = [];
    const wrongEventWeight = structuredClone(snapshot);
    wrongEventWeight.ledger[0].points = 9;

    expect(() => assertLeaderboardSnapshot(missingLedger)).toThrow(
      "does not match the public ledger",
    );
    expect(() => assertLeaderboardSnapshot(wrongEventWeight)).toThrow(
      "points does not match its scoring category",
    );
  });

  it("rejects model attribution without a same-actor ledger cause", () => {
    const snapshot = createLeaderboardSnapshot(
      input({
        mergedPullRequests: [
          pullRequest({
            body: machineAttribution("OpenAI", "gpt-5.6-sol"),
          }),
        ],
      }),
    );
    const unrelatedArtifact = structuredClone(snapshot);
    unrelatedArtifact.attributions[0].artifactId = "PR_UNRELATED";

    expect(() => assertLeaderboardSnapshot(unrelatedArtifact)).toThrow(
      "is not causally linked to a public ledger event by the same actor",
    );
  });

  it("rejects a queue that hides actionable unclaimed work below a claim", () => {
    const snapshot = createLeaderboardSnapshot(
      input({
        openIssues: [
          issue({
            id: "ISSUE_UNCLAIMED",
            number: 50,
            closedAt: null,
            stateReason: null,
            labels: [],
          }),
          issue({
            id: "ISSUE_CLAIMED",
            number: 51,
            closedAt: null,
            stateReason: null,
            labels: [{ id: "LABEL_CLAIM", name: "claimed", color: "ffffff" }],
          }),
        ],
      }),
    );
    const malformed = structuredClone(snapshot);
    malformed.workQueue.issues.reverse();

    expect(() => assertLeaderboardSnapshot(malformed)).toThrow(
      "must prioritize actionable, unclaimed, labeled, recent work",
    );
  });

  it("rejects queue claim and blocked state that contradict their labels", () => {
    const snapshot = createLeaderboardSnapshot(
      input({
        openIssues: [
          issue({
            id: "ISSUE_LABEL_STATE",
            number: 52,
            closedAt: null,
            stateReason: null,
            labels: [
              { id: "LABEL_READY", name: "help wanted", color: "ffffff" },
              { id: "LABEL_CLAIM", name: "claimed", color: "ffffff" },
              { id: "LABEL_BLOCKED", name: "status/proposal", color: "ffffff" },
            ],
          }),
        ],
      }),
    );
    const unclaimed = structuredClone(snapshot);
    unclaimed.workQueue.issues[0].claim = {
      status: "unclaimed",
      source: "none",
      kind: null,
      actors: [],
      claimedAt: null,
    };
    unclaimed.workQueue.issues[0].selection = {
      status: "excluded",
      reasons: ["blocked"],
    };
    const actionable = structuredClone(snapshot);
    actionable.workQueue.issues[0].actionability = "actionable";
    actionable.workQueue.issues[0].selection = {
      status: "excluded",
      reasons: ["claimed"],
    };

    expect(() => assertLeaderboardSnapshot(unclaimed)).toThrow(
      "claim fields do not describe one valid claim",
    );
    expect(() => assertLeaderboardSnapshot(actionable)).toThrow(
      "actionability does not match its labels",
    );
  });
});
