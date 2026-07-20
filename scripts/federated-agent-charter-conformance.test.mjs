import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "docs", "federated-agent-charter.schema.json");
const HARD_EDGES = new Set(["requires", "blocks", "stacks_on"]);
const TERMINAL_STATES = new Set(["done", "cancelled"]);
const SENSITIVE = new Set([
  "security",
  "migration_schema",
  "money",
  "deployment",
  "merge",
]);

function parseTime(value) {
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time), `invalid timestamp: ${value}`);
  return time;
}

function normalizePath(value) {
  return String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function pathOverlaps(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function resourcesOverlap(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "path") return pathOverlaps(left.id, right.id);
  return left.id === right.id;
}

function claimsOverlap(left, right) {
  if (left.repoId !== right.repoId) return false;
  if (left.mode === "shared_read" && right.mode === "shared_read") return false;
  return left.resources.some((a) => right.resources.some((b) => resourcesOverlap(a, b)));
}

function isActive(claim, registryNow) {
  return (
    claim.status === "active" &&
    parseTime(claim.expiresAt) > parseTime(registryNow)
  );
}

function collisionWinner(left, right) {
  const acquired = left.acquiredAt.localeCompare(right.acquiredAt);
  if (acquired !== 0) return acquired < 0 ? left : right;
  return left.claimId.localeCompare(right.claimId) <= 0 ? left : right;
}

function topologicalOrder(workIds, edges) {
  const sortedIds = [...workIds].sort();
  const indegree = new Map(sortedIds.map((id) => [id, 0]));
  const outgoing = new Map(sortedIds.map((id) => [id, []]));
  for (const edge of edges.filter((item) => HARD_EDGES.has(item.type))) {
    assert.notEqual(edge.fromWorkId, edge.toWorkId, "hard self-cycle");
    assert.ok(indegree.has(edge.fromWorkId), `unknown edge source ${edge.fromWorkId}`);
    assert.ok(indegree.has(edge.toWorkId), `unknown edge target ${edge.toWorkId}`);
    outgoing.get(edge.fromWorkId).push(edge.toWorkId);
    indegree.set(edge.toWorkId, indegree.get(edge.toWorkId) + 1);
  }
  const ready = sortedIds.filter((id) => indegree.get(id) === 0);
  const result = [];
  while (ready.length > 0) {
    ready.sort();
    const current = ready.shift();
    result.push(current);
    for (const next of outgoing.get(current).sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  assert.equal(result.length, sortedIds.length, "hard dependency cycle");
  return result;
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    assert.ok(!seen.has(item[key]), `duplicate ${label}: ${item[key]}`);
    seen.add(item[key]);
  }
}

function approvalCovers(work, approval, registryNow, headSha) {
  return (
    approval?.workId === work.workId &&
    approval.status === "approved" &&
    approval.headSha === headSha &&
    parseTime(approval.expiresAt) > parseTime(registryNow) &&
    work.sensitiveClasses.every((failureClass) =>
      approval.failureClasses.includes(failureClass),
    )
  );
}

function assertReviewIndependent({ work, review, agents, headSha }) {
  assert.equal(review.workId, work.workId);
  assert.equal(review.headSha, headSha, "review is stale for current head");
  assert.equal(review.verdict, "approve");
  const implementation = work.accountability.find(
    (entry) => entry.failureClass === "implementation",
  );
  const implementer = agents.find(
    (agent) => agent.agentId === implementation.accountableAgentId,
  );
  const reviewer = agents.find((agent) => agent.agentId === review.reviewerAgentId);
  assert.ok(implementer, "implementation owner must be a registered agent");
  assert.ok(reviewer, "reviewer must be a registered agent");
  assert.notEqual(reviewer.agentId, implementer.agentId, "self review");
  assert.notEqual(
    reviewer.independenceGroup,
    implementer.independenceGroup,
    "reviewer is not independent",
  );
}

function assertFence(claim, suppliedGeneration, registryNow) {
  assert.ok(isActive(claim, registryNow), "claim is not active");
  assert.equal(suppliedGeneration, claim.generation, "stale_fence");
}

function reclaimClaim(claim, successor, now) {
  assert.ok(parseTime(claim.expiresAt) <= parseTime(now), "claim is not expired");
  return {
    ...claim,
    claimId: successor.claimId,
    ownerAgentId: successor.ownerAgentId,
    ownerSessionId: successor.ownerSessionId,
    status: "active",
    generation: claim.generation + 1,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: successor.expiresAt,
    predecessorClaimId: claim.claimId,
    progressRevision: claim.progressRevision,
    noProgressRenewals: 0,
  };
}

function assertExternalWriteBarrier({ frame, receipt, idempotencyKey }) {
  assert.equal(frame.replayable, false, "external write frame must not be replayable");
  assert.ok(idempotencyKey, "external write requires idempotency key");
  assert.equal(receipt.idempotencyKey, idempotencyKey);
  assert.equal(receipt.status, "recorded");
}

function validateSnapshot(snapshot) {
  assert.equal(snapshot.charterVersion, "1.0.0-proposal.1");
  parseTime(snapshot.registryNow);
  assertUnique(snapshot.teams, "teamId", "teamId");
  assertUnique(snapshot.agents, "agentId", "agentId");
  assertUnique(snapshot.workItems, "workId", "workId");
  assertUnique(snapshot.claims, "claimId", "claimId");
  assertUnique(snapshot.evidence, "evidenceId", "evidenceId");
  assertUnique(snapshot.reviews, "reviewId", "reviewId");
  assertUnique(snapshot.approvals, "approvalId", "approvalId");

  const teamIds = new Set(snapshot.teams.map((item) => item.teamId));
  const agentIds = new Set(snapshot.agents.map((item) => item.agentId));
  const workIds = new Set(snapshot.workItems.map((item) => item.workId));
  for (const agent of snapshot.agents) {
    assert.ok(teamIds.has(agent.teamId), `unknown team ${agent.teamId}`);
  }

  for (const work of snapshot.workItems) {
    const classes = work.accountability.map((entry) => entry.failureClass);
    assert.equal(new Set(classes).size, classes.length, `duplicate accountability in ${work.workId}`);
    for (const entry of work.accountability) {
      const owners = [
        entry.accountableAgentId,
        entry.accountableTeamId,
        entry.accountableHumanId,
      ].filter(Boolean);
      assert.equal(owners.length, 1, `failure class ${entry.failureClass} must have one owner`);
      if (entry.accountableAgentId) assert.ok(agentIds.has(entry.accountableAgentId));
      if (entry.accountableTeamId) assert.ok(teamIds.has(entry.accountableTeamId));
      if (entry.failureClass === "human_acceptance") {
        assert.ok(entry.accountableHumanId, "human acceptance requires a human");
      }
    }
    assert.ok(
      work.accountability.some((entry) => entry.failureClass === "implementation"),
      `${work.workId} lacks implementation accountability`,
    );
  }

  for (const claim of snapshot.claims) {
    assert.ok(workIds.has(claim.workId), `claim references unknown work ${claim.workId}`);
    assert.ok(agentIds.has(claim.ownerAgentId), `claim references unknown agent ${claim.ownerAgentId}`);
    if (TERMINAL_STATES.has(snapshot.workItems.find((w) => w.workId === claim.workId).state)) {
      assert.ok(!isActive(claim, snapshot.registryNow), "terminal work retains active claim");
    }
  }

  const activeClaims = snapshot.claims.filter((claim) => isActive(claim, snapshot.registryNow));
  for (let i = 0; i < activeClaims.length; i += 1) {
    for (let j = i + 1; j < activeClaims.length; j += 1) {
      const left = activeClaims[i];
      const right = activeClaims[j];
      if (left.ownerAgentId !== right.ownerAgentId && claimsOverlap(left, right)) {
        assert.fail(`overlapping active claims: ${left.claimId}, ${right.claimId}`);
      }
    }
  }

  topologicalOrder(workIds, snapshot.graphEdges);

  const epoch = snapshot.authorityEpoch;
  const writeModes = [epoch.githubMode, epoch.forgejoMode].filter((mode) => mode === "write");
  assert.equal(writeModes.length, 1, "exactly one forge write authority is required");
  assert.equal(
    epoch.writeAuthority === "github" ? epoch.githubMode : epoch.forgejoMode,
    "write",
    "writeAuthority and adapter mode disagree",
  );

  return true;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const D = `sha256:${"d".repeat(64)}`;
const WORK = "work:v1:github:elizaOS%2Feliza:issue:16632";
const WORK_2 = "work:v1:github:elizaOS%2Feliza:issue:16436";
const SOL = "agent:v1:elizaOS:sol-orch";
const NUBS = "agent:v1:elizaOS:nubs-agent";
const TEAM_SOL = "team:v1:elizaOS:wakesync";
const TEAM_NUBS = "team:v1:elizaOS:nubs";
const NOW = "2026-07-20T06:30:00.000Z";

function fixture() {
  return {
    charterVersion: "1.0.0-proposal.1",
    registryNow: NOW,
    authorityEpoch: {
      repoId: "elizaOS/eliza",
      epoch: 1,
      writeAuthority: "github",
      effectiveAt: "2026-07-20T00:00:00.000Z",
      githubMode: "write",
      forgejoMode: "read_mirror",
      approvedBy: ["human:wakesync"],
      evidenceDigest: D,
    },
    teams: [
      { teamId: TEAM_SOL, displayName: "Wakesync", status: "active" },
      { teamId: TEAM_NUBS, displayName: "Nubs", status: "active" },
    ],
    agents: [
      {
        agentId: SOL,
        teamId: TEAM_SOL,
        displayTag: "[sol-orch]",
        independenceGroup: "wakesync-runtime",
        capabilities: ["implementation"],
        authorizedPillars: ["agent-orchestration"],
        maxConcurrentClaims: 2,
        status: "active",
        registeredBy: "human:wakesync",
      },
      {
        agentId: NUBS,
        teamId: TEAM_NUBS,
        displayTag: "[nubs-agent]",
        independenceGroup: "nubs-runtime",
        capabilities: ["review"],
        authorizedPillars: ["quality-evidence"],
        maxConcurrentClaims: 2,
        status: "active",
        registeredBy: "human:nubs",
      },
    ],
    workItems: [
      {
        workId: WORK,
        title: "Smithers pilot",
        repoId: "elizaOS/eliza",
        pillar: "agent-orchestration",
        state: "needs_agent_review",
        targetBranch: "develop",
        paths: ["plugins/plugin-agent-orchestrator"],
        packages: ["plugin-agent-orchestrator"],
        aliases: ["github:elizaOS/eliza#16632"],
        accountability: [
          { failureClass: "implementation", accountableAgentId: SOL },
          { failureClass: "test_evidence", accountableAgentId: SOL },
          { failureClass: "merge", accountableHumanId: "human:maintainer" },
        ],
        sensitiveClasses: ["merge"],
        smithersRunId: "smithers-p1-16638",
        pullRequestRefs: ["github:elizaOS/eliza#16638"],
      },
      {
        workId: WORK_2,
        title: "Hub ownership decision",
        repoId: "elizaOS/eliza",
        pillar: "forge-landing",
        state: "blocked_dependency",
        targetBranch: "develop",
        paths: ["packages/eliza-hub"],
        packages: ["eliza-hub"],
        aliases: ["github:elizaOS/eliza#16436"],
        accountability: [
          { failureClass: "implementation", accountableAgentId: NUBS },
          { failureClass: "human_acceptance", accountableHumanId: "human:wakesync" },
        ],
        sensitiveClasses: [],
        pullRequestRefs: [],
      },
    ],
    claims: [
      {
        claimId: "claim_smithers_review",
        workId: WORK,
        repoId: "elizaOS/eliza",
        ownerAgentId: NUBS,
        ownerSessionId: `session:v1:${NUBS}:r1`,
        resources: [{ kind: "path", id: "plugins/plugin-agent-orchestrator" }],
        mode: "review",
        status: "active",
        generation: 3,
        acquiredAt: "2026-07-20T06:20:00.000Z",
        renewedAt: "2026-07-20T06:25:00.000Z",
        expiresAt: "2026-07-20T07:00:00.000Z",
        progressRevision: 2,
        noProgressRenewals: 0,
      },
    ],
    graphEdges: [
      { fromWorkId: WORK, toWorkId: WORK_2, type: "requires", source: "declared" },
    ],
    evidence: [
      {
        evidenceId: "evidence_smithers",
        workId: WORK,
        producerAgentId: SOL,
        producerSessionId: `session:v1:${SOL}:r1`,
        baseSha: A,
        headSha: B,
        level: "E2",
        claimFences: [],
        commands: [],
        knownFailures: [],
        redactions: [],
        createdAt: "2026-07-20T06:15:00.000Z",
      },
    ],
    reviews: [
      {
        reviewId: "review_nubs",
        workId: WORK,
        reviewerAgentId: NUBS,
        independenceGroup: "nubs-runtime",
        pullRequestRef: "github:elizaOS/eliza#16638",
        baseSha: A,
        headSha: B,
        failureClasses: ["implementation", "test_evidence"],
        verdict: "approve",
        findings: [],
        evidenceIds: ["evidence_smithers"],
        createdAt: "2026-07-20T06:29:00.000Z",
      },
    ],
    approvals: [
      {
        approvalId: "approval_merge",
        workId: WORK,
        failureClasses: ["merge"],
        action: "merge governance proposal",
        environment: "github:develop",
        headSha: B,
        riskDigest: D,
        status: "approved",
        allowedHumanIds: ["human:maintainer"],
        decidedBy: "human:maintainer",
        requestedAt: "2026-07-20T06:20:00.000Z",
        decidedAt: "2026-07-20T06:25:00.000Z",
        expiresAt: "2026-07-20T07:00:00.000Z",
        oneShot: true,
      },
    ],
  };
}

test("machine-readable schema exposes all normative object definitions", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  for (const name of [
    "authorityEpoch",
    "team",
    "agent",
    "workItem",
    "claim",
    "graphEdge",
    "evidenceReceipt",
    "reviewReceipt",
    "approval",
  ]) {
    assert.ok(schema.$defs[name], `missing schema definition ${name}`);
  }
  assert.ok(schema.required.includes("authorityEpoch"));
  assert.ok(schema.required.includes("claims"));
  assert.ok(schema.required.includes("reviews"));
});

test("valid federated snapshot passes semantic conformance", () => {
  assert.equal(validateSnapshot(fixture()), true);
});

test("path overlap is segment aware", () => {
  assert.equal(pathOverlaps("packages/app", "packages/app/src/a.ts"), true);
  assert.equal(pathOverlaps("./packages/app/", "packages/app"), true);
  assert.equal(pathOverlaps("packages/app", "packages/app-old/src/a.ts"), false);
});

test("foreign overlapping live claims fail closed", () => {
  const value = fixture();
  value.claims.push({
    ...value.claims[0],
    claimId: "claim_collision",
    ownerAgentId: SOL,
    ownerSessionId: `session:v1:${SOL}:r2`,
    mode: "exclusive",
  });
  assert.throws(() => validateSnapshot(value), /overlapping active claims/);
});

test("expired claims do not block and reclamation increments the fence", () => {
  const old = {
    ...fixture().claims[0],
    status: "active",
    generation: 8,
    expiresAt: "2026-07-20T06:29:59.000Z",
  };
  assert.equal(isActive(old, NOW), false);
  const next = reclaimClaim(
    old,
    {
      claimId: "claim_successor",
      ownerAgentId: SOL,
      ownerSessionId: `session:v1:${SOL}:r3`,
      expiresAt: "2026-07-20T06:50:00.000Z",
    },
    NOW,
  );
  assert.equal(next.generation, 9);
  assert.equal(next.predecessorClaimId, old.claimId);
  assert.throws(() => assertFence(next, 8, NOW), /stale_fence/);
  assert.doesNotThrow(() => assertFence(next, 9, NOW));
});

test("collision winner is deterministic", () => {
  const left = { claimId: "claim_b", acquiredAt: "2026-07-20T06:00:00.000Z" };
  const right = { claimId: "claim_a", acquiredAt: "2026-07-20T06:00:00.000Z" };
  assert.equal(collisionWinner(left, right), right);
  assert.equal(
    collisionWinner(
      left,
      { ...right, acquiredAt: "2026-07-20T06:00:01.000Z" },
    ),
    left,
  );
});

test("hard dependency ordering is lexical and cycles are rejected", () => {
  const ids = new Set([WORK, WORK_2]);
  assert.deepEqual(
    topologicalOrder(ids, [
      { fromWorkId: WORK, toWorkId: WORK_2, type: "requires" },
    ]),
    [WORK, WORK_2],
  );
  assert.throws(
    () =>
      topologicalOrder(ids, [
        { fromWorkId: WORK, toWorkId: WORK_2, type: "requires" },
        { fromWorkId: WORK_2, toWorkId: WORK, type: "stacks_on" },
      ]),
    /hard dependency cycle/,
  );
});

test("accountability rejects duplicate owners for one failure class", () => {
  const value = fixture();
  value.workItems[0].accountability.push({
    failureClass: "implementation",
    accountableAgentId: NUBS,
  });
  assert.throws(() => validateSnapshot(value), /duplicate accountability/);
});

test("human acceptance cannot be assigned to an agent", () => {
  const value = fixture();
  value.workItems[1].accountability[1] = {
    failureClass: "human_acceptance",
    accountableAgentId: NUBS,
  };
  assert.throws(() => validateSnapshot(value), /human acceptance requires a human/);
});

test("review must be independent and bound to current head", () => {
  const value = fixture();
  assert.doesNotThrow(() =>
    assertReviewIndependent({
      work: value.workItems[0],
      review: value.reviews[0],
      agents: value.agents,
      headSha: B,
    }),
  );
  assert.throws(
    () =>
      assertReviewIndependent({
        work: value.workItems[0],
        review: { ...value.reviews[0], reviewerAgentId: SOL, independenceGroup: "wakesync-runtime" },
        agents: value.agents,
        headSha: B,
      }),
    /self review|not independent/,
  );
  assert.throws(
    () =>
      assertReviewIndependent({
        work: value.workItems[0],
        review: value.reviews[0],
        agents: value.agents,
        headSha: A,
      }),
    /review is stale/,
  );
});

test("sensitive classes require unexpired exact-head HITL approval", () => {
  const value = fixture();
  const work = value.workItems[0];
  assert.ok(work.sensitiveClasses.every((item) => SENSITIVE.has(item)));
  assert.equal(approvalCovers(work, value.approvals[0], NOW, B), true);
  assert.equal(approvalCovers(work, value.approvals[0], NOW, A), false);
  assert.equal(
    approvalCovers(
      work,
      { ...value.approvals[0], expiresAt: "2026-07-20T06:29:59.000Z" },
      NOW,
      B,
    ),
    false,
  );
});

test("terminal work cannot retain an active claim", () => {
  const value = fixture();
  value.workItems[0].state = "done";
  assert.throws(() => validateSnapshot(value), /terminal work retains active claim/);
});

test("exactly one forge has write authority", () => {
  const value = fixture();
  value.authorityEpoch.forgejoMode = "write";
  assert.throws(() => validateSnapshot(value), /exactly one forge write authority/);
});

test("Smithers replay cannot repeat an external write", () => {
  assert.doesNotThrow(() =>
    assertExternalWriteBarrier({
      frame: { replayable: false },
      receipt: { idempotencyKey: "push:work:16632:head-b", status: "recorded" },
      idempotencyKey: "push:work:16632:head-b",
    }),
  );
  assert.throws(
    () =>
      assertExternalWriteBarrier({
        frame: { replayable: true },
        receipt: { idempotencyKey: "push:work:16632:head-b", status: "recorded" },
        idempotencyKey: "push:work:16632:head-b",
      }),
    /must not be replayable/,
  );
});
