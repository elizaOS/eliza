/**
 * Executable conformance contract for the Federated Agent Fleet Charter.
 * JSON Schema validates the portable receipt shapes; the semantic checks below
 * validate the cross-record invariants a schema cannot express, including
 * resource fences, review independence, HITL consumption, and forge epochs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "docs", "federated-agent-charter.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const HARD_EDGES = new Set(["requires", "blocks", "stacks_on"]);
const TERMINAL_STATES = new Set(["done", "cancelled"]);
const ACTIVE_CLAIM_STATUSES = new Set(["active", "suspect"]);
const WRITE_MODES = new Set(["exclusive", "shared_write"]);
const SENSITIVE = new Set([
  "security",
  "migration_schema",
  "money",
  "deployment",
  "merge",
  "human_acceptance",
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

function resourceKey(repoId, resource) {
  const id = resource.kind === "path" ? normalizePath(resource.id) : resource.id;
  return `${repoId}:${resource.kind}:${id}`;
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

function claimCanMutate(claim) {
  return WRITE_MODES.has(claim.mode);
}

function isActive(claim, registryNow) {
  return (
    ACTIVE_CLAIM_STATUSES.has(claim.status) &&
    parseTime(claim.expiresAt) > parseTime(registryNow)
  );
}

function collisionWinner(left, right) {
  const acquired = left.acquiredAt.localeCompare(right.acquiredAt);
  if (acquired !== 0) return acquired < 0 ? left : right;
  return left.claimId.localeCompare(right.claimId) <= 0 ? left : right;
}

function canonicalHardEdge(edge) {
  if (edge.type === "requires" || edge.type === "stacks_on") {
    return { predecessor: edge.toWorkId, successor: edge.fromWorkId };
  }
  if (edge.type === "blocks") {
    return { predecessor: edge.fromWorkId, successor: edge.toWorkId };
  }
  return null;
}

function topologicalOrder(workIds, edges) {
  const sortedIds = [...workIds].sort();
  const indegree = new Map(sortedIds.map((id) => [id, 0]));
  const outgoing = new Map(sortedIds.map((id) => [id, []]));
  for (const edge of edges.filter((item) => HARD_EDGES.has(item.type))) {
    assert.notEqual(edge.fromWorkId, edge.toWorkId, "hard self-cycle");
    const hardEdge = canonicalHardEdge(edge);
    assert.ok(indegree.has(hardEdge.predecessor), `unknown edge source ${hardEdge.predecessor}`);
    assert.ok(indegree.has(hardEdge.successor), `unknown edge target ${hardEdge.successor}`);
    outgoing.get(hardEdge.predecessor).push(hardEdge.successor);
    indegree.set(hardEdge.successor, indegree.get(hardEdge.successor) + 1);
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

function assertDisjoint(values, label) {
  const seen = new Map();
  for (const { owner, value } of values) {
    if (value == null) continue;
    assert.ok(!seen.has(value), `duplicate ${label}: ${value} used by ${seen.get(value)} and ${owner}`);
    seen.set(value, owner);
  }
}

function assertDraft202012Valid(instance) {
  const input = JSON.stringify({ schema: SCHEMA, instance });
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sys",
        "from jsonschema import Draft202012Validator, FormatChecker",
        "payload = json.load(sys.stdin)",
        "schema = payload['schema']",
        "instance = payload['instance']",
        "Draft202012Validator.check_schema(schema)",
        "validator = Draft202012Validator(schema, format_checker=FormatChecker())",
        "errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))",
        "if errors:",
        "    for error in errors:",
        "        path = '/'.join(str(p) for p in error.absolute_path) or '<root>'",
        "        print(f'{path}: {error.message}', file=sys.stderr)",
        "    sys.exit(1)",
      ].join("\n"),
    ],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function parseWorkId(workId) {
  const match = /^work:v1:(github|forgejo|internal):([^:]+):(issue|discussion|task|incident|release):([^:]+)$/.exec(workId);
  assert.ok(match, `invalid workId ${workId}`);
  return {
    authority: match[1],
    repoId: decodeURIComponent(match[2]),
    kind: match[3],
    nativeId: match[4],
  };
}

function approvalCovers(work, approval, registryNow, request) {
  return (
    approval?.workId === work.workId &&
    approval.status === "approved" &&
    approval.headSha === request.headSha &&
    approval.action === request.action &&
    approval.environment === request.environment &&
    approval.riskDigest === request.riskDigest &&
    approval.allowedActorId === request.actorId &&
    approval.decidedBy != null &&
    approval.allowedHumanIds.includes(approval.decidedBy) &&
    parseTime(approval.expiresAt) > parseTime(registryNow) &&
    work.sensitiveClasses.every((failureClass) =>
      approval.failureClasses.includes(failureClass),
    )
  );
}

function consumeApproval(approval, request) {
  assert.equal(approval.oneShot, true, "approval must be one-shot");
  assert.equal(approval.status, "approved", "approval is not approved");
  assert.equal(approval.headSha, request.headSha, "approval head mismatch");
  assert.equal(approval.action, request.action, "approval action mismatch");
  assert.equal(approval.environment, request.environment, "approval environment mismatch");
  assert.equal(approval.riskDigest, request.riskDigest, "approval risk mismatch");
  assert.equal(approval.allowedActorId, request.actorId, "approval actor mismatch");
  assert.ok(approval.allowedHumanIds.includes(approval.decidedBy), "decider is not authorized");
  approval.status = "consumed";
  approval.consumedAt = request.executedAt;
}

function assertReviewIndependent({ work, review, agents, claims, registryNow, headSha }) {
  assert.equal(review.workId, work.workId);
  assert.equal(review.headSha, headSha, "review is stale for current head");
  assert.equal(review.verdict, "approve");
  const implementation = work.accountability.find(
    (entry) => entry.failureClass === "implementation",
  );
  const implementer = agents.find(
    (agent) => agent.agentId === implementation?.accountableAgentId,
  );
  const reviewer = agents.find((agent) => agent.agentId === review.reviewerAgentId);
  assert.ok(implementer, "implementation owner must be a registered agent");
  assert.ok(reviewer, "reviewer must be a registered agent");
  assert.equal(review.independenceGroup, reviewer.independenceGroup, "review receipt independenceGroup disagrees with registry");
  assert.notEqual(reviewer.agentId, implementer.agentId, "self review");
  assert.notEqual(reviewer.teamId, implementer.teamId, "same team review");
  assert.notEqual(
    reviewer.independenceGroup,
    implementer.independenceGroup,
    "reviewer is not independent",
  );
  assert.ok(
    !review.reviewedCommitAuthorAgentIds.includes(reviewer.agentId),
    "reviewer authored reviewed commits",
  );
  for (const claimId of review.activeWriteClaimIdsAtReview) {
    const claim = claims.find((item) => item.claimId === claimId);
    assert.ok(claim, `review references unknown active write claim ${claimId}`);
    assert.notEqual(claim.ownerAgentId, reviewer.agentId, "reviewer held write lease during review");
    assert.ok(!isActive(claim, registryNow) || !claimCanMutate(claim), "review references active mutation lease");
  }
}

function assertFence(claim, suppliedGeneration, registryNow) {
  assert.ok(isActive(claim, registryNow), "claim is not active");
  assert.equal(suppliedGeneration, claim.generation, "stale_fence");
}

function renewClaim(claim, { now, progressRevision = claim.progressRevision, reviewerApprovalId = null }) {
  const noProgressRenewals =
    progressRevision === claim.progressRevision ? (claim.noProgressRenewals ?? 0) + 1 : 0;
  if (noProgressRenewals >= 3 && reviewerApprovalId == null) {
    return { ...claim, status: "suspect", renewedAt: now, noProgressRenewals };
  }
  return { ...claim, renewedAt: now, progressRevision, noProgressRenewals };
}

function reclaimClaimAtomic(registry, predecessorClaimId, successor, now) {
  const old = registry.claims.find((claim) => claim.claimId === predecessorClaimId);
  assert.ok(old, `unknown predecessor claim ${predecessorClaimId}`);
  assert.ok(parseTime(old.expiresAt) <= parseTime(now), "claim is not expired");
  assert.ok(!registry.reclaimedPredecessors.has(predecessorClaimId), "predecessor claim already reclaimed");
  const keys = old.resources.map((resource) => resourceKey(old.repoId, resource));
  for (const key of keys) {
    const fence = registry.resourceFences.get(key);
    assert.ok(fence, `missing resource fence ${key}`);
    assert.equal(fence.generation, old.generation, "resource CAS generation mismatch");
    fence.generation += 1;
  }
  registry.reclaimedPredecessors.add(predecessorClaimId);
  const nextGeneration = registry.resourceFences.get(keys[0]).generation;
  const next = {
    ...old,
    claimId: successor.claimId,
    ownerAgentId: successor.ownerAgentId,
    ownerSessionId: successor.ownerSessionId,
    status: "active",
    generation: nextGeneration,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: successor.expiresAt,
    predecessorClaimId: old.claimId,
    progressRevision: old.progressRevision,
    noProgressRenewals: 0,
  };
  registry.claims.push(next);
  return next;
}

function assertExternalWriteBarrier({ frame, receipt, idempotencyKey }) {
  assert.equal(frame.replayable, false, "external write frame must not be replayable");
  assert.ok(idempotencyKey, "external write requires idempotency key");
  assert.equal(frame.idempotencyKey, idempotencyKey);
  assert.equal(receipt.idempotencyKey, idempotencyKey);
  assert.equal(receipt.status, "recorded");
}

function activeAuthorityEpoch(snapshot, now = snapshot.registryNow) {
  const effective = snapshot.authorityEpochs
    .filter((epoch) => parseTime(epoch.effectiveAt) <= parseTime(now))
    .sort((left, right) => right.epoch - left.epoch);
  assert.ok(effective.length > 0, "no active authority epoch");
  return effective[0];
}

function assertForgeWriteAllowed(snapshot, write) {
  const epoch = activeAuthorityEpoch(snapshot, write.at);
  assert.equal(write.epoch, epoch.epoch, "stale authority epoch");
  assert.equal(write.forge, epoch.writeAuthority, "write sent to non-authoritative forge");
  assert.equal(write.workId, write.commitWorkId, "forge commit/workId divergence");
}

function assertNoMirrorDivergence(snapshot) {
  for (const mirror of snapshot.mirrorStates) {
    assert.equal(mirror.authorityHeadSha, mirror.mirrorHeadSha, `mirror divergence for ${mirror.repoId}`);
    assert.equal(mirror.authorityWorkId, mirror.mirrorWorkId, `mirror workId divergence for ${mirror.repoId}`);
  }
}

function assertMergePreflight({ work, actorId, headSha, requiredChecks, mergeAuthorities, approvals, registryNow }) {
  assert.ok(!requiredChecks.some((check) => check.status !== "success"), "required check is red");
  const implementation = work.accountability.find((entry) => entry.failureClass === "implementation");
  assert.notEqual(actorId, implementation?.accountableAgentId, "implementation ownership confers no merge authority");
  const grant = mergeAuthorities.find(
    (authority) =>
      authority.actorId === actorId &&
      authority.repoId === work.repoId &&
      authority.targetBranch === work.targetBranch &&
      authority.status === "active" &&
      parseTime(authority.expiresAt) > parseTime(registryNow),
  );
  assert.ok(grant, "missing merge authority");
  const approval = approvals.find((item) =>
    approvalCovers(work, item, registryNow, {
      actorId,
      headSha,
      action: "merge",
      environment: `github:${work.targetBranch}`,
      riskDigest: item.riskDigest,
    }),
  );
  assert.ok(approval, "missing merge HITL approval");
}

function validateSnapshot(snapshot) {
  assertDraft202012Valid(snapshot);
  assert.equal(snapshot.charterVersion, "1.0.0-proposal.1");
  parseTime(snapshot.registryNow);
  assertUnique(snapshot.teams, "teamId", "teamId");
  assertUnique(snapshot.agents, "agentId", "agentId");
  assertUnique(snapshot.workItems, "workId", "workId");
  assertUnique(snapshot.claims, "claimId", "claimId");
  assertUnique(snapshot.handoffs, "handoffId", "handoffId");
  assertUnique(snapshot.evidence, "evidenceId", "evidenceId");
  assertUnique(snapshot.reviews, "reviewId", "reviewId");
  assertUnique(snapshot.approvals, "approvalId", "approvalId");
  assertUnique(snapshot.mergeAuthorities, "mergeAuthorityId", "mergeAuthorityId");

  const teamIds = new Set(snapshot.teams.map((item) => item.teamId));
  const agentIds = new Set(snapshot.agents.map((item) => item.agentId));
  const workIds = new Set(snapshot.workItems.map((item) => item.workId));
  const claimIds = new Set(snapshot.claims.map((item) => item.claimId));
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.evidenceId));
  const approvalIds = new Set(snapshot.approvals.map((item) => item.approvalId));

  assertDisjoint(
    snapshot.agents.flatMap((agent) =>
      (agent.forgePrincipals ?? []).map((value) => ({ owner: agent.agentId, value })),
    ),
    "forge principal",
  );
  assertDisjoint(
    snapshot.agents.map((agent) => ({ owner: agent.agentId, value: agent.displayTag })),
    "displayTag",
  );
  assertDisjoint(
    snapshot.agents.map((agent) => ({ owner: agent.agentId, value: agent.runtimePrincipal })),
    "runtime principal",
  );

  for (const agent of snapshot.agents) {
    assert.ok(teamIds.has(agent.teamId), `unknown team ${agent.teamId}`);
  }

  for (const work of snapshot.workItems) {
    const parsed = parseWorkId(work.workId);
    assert.equal(parsed.repoId, work.repoId, `workId repo mismatch for ${work.workId}`);
    assert.ok(work.aliases.length > 0, `${work.workId} has no preserved alias`);
    const classes = work.accountability.map((entry) => entry.failureClass);
    assert.equal(new Set(classes).size, classes.length, `duplicate accountability in ${work.workId}`);
    for (const entry of work.accountability) {
      const owners = [
        entry.accountableAgentId,
        entry.accountableTeamId,
        entry.accountableHumanId,
      ].filter(Boolean);
      assert.equal(owners.length, 1, `failure class ${entry.failureClass} must have one owner`);
      if (entry.accountableAgentId) assert.ok(agentIds.has(entry.accountableAgentId), `unknown agent ${entry.accountableAgentId}`);
      if (entry.accountableTeamId) assert.ok(teamIds.has(entry.accountableTeamId), `unknown team ${entry.accountableTeamId}`);
      if (entry.failureClass === "human_acceptance") {
        assert.ok(entry.accountableHumanId, "human acceptance requires a human");
      }
    }
    assert.ok(
      work.accountability.some((entry) => entry.failureClass === "implementation"),
      `${work.workId} lacks implementation accountability`,
    );
    if (work.sensitiveClasses.some((item) => SENSITIVE.has(item))) {
      assert.ok(
        work.accountability.some((entry) => entry.failureClass === "human_acceptance" || entry.failureClass === "merge"),
        `${work.workId} lacks human or merge accountability for sensitive work`,
      );
    }
  }

  for (const transition of snapshot.lifecycleTransitions) {
    assert.ok(workIds.has(transition.workId), `transition references unknown work ${transition.workId}`);
  }

  for (const claim of snapshot.claims) {
    assert.ok(workIds.has(claim.workId), `claim references unknown work ${claim.workId}`);
    assert.ok(agentIds.has(claim.ownerAgentId), `claim references unknown agent ${claim.ownerAgentId}`);
    assert.ok(
      claim.ownerSessionId.startsWith(`session:v1:${claim.ownerAgentId}:`),
      "ownerSessionId does not belong to ownerAgentId",
    );
    const work = snapshot.workItems.find((item) => item.workId === claim.workId);
    if (TERMINAL_STATES.has(work.state)) {
      assert.ok(!isActive(claim, snapshot.registryNow), "terminal work retains active claim");
    }
    if ((claim.noProgressRenewals ?? 0) >= 3) {
      assert.equal(claim.status, "suspect", "no-progress renewal must become suspect");
    }
  }

  const activeClaims = snapshot.claims.filter((claim) => isActive(claim, snapshot.registryNow));
  for (const agent of snapshot.agents) {
    const owned = activeClaims.filter((claim) => claim.ownerAgentId === agent.agentId);
    assert.ok(
      owned.length <= agent.maxConcurrentClaims,
      `maxConcurrentClaims exceeded for ${agent.agentId}`,
    );
  }
  for (let i = 0; i < activeClaims.length; i += 1) {
    for (let j = i + 1; j < activeClaims.length; j += 1) {
      const left = activeClaims[i];
      const right = activeClaims[j];
      if (claimsOverlap(left, right)) {
        assert.fail(`overlapping active claims: ${left.claimId}, ${right.claimId}`);
      }
    }
  }

  for (const fence of snapshot.resourceFences) {
    const matching = snapshot.claims.filter((claim) =>
      claim.resources.some((resource) => resourceKey(claim.repoId, resource) === fence.resourceKey),
    );
    assert.ok(matching.some((claim) => claim.generation === fence.currentGeneration), `resource fence has no matching generation ${fence.resourceKey}`);
  }
  const predecessors = new Set();
  for (const claim of snapshot.claims.filter((item) => item.predecessorClaimId)) {
    assert.ok(claimIds.has(claim.predecessorClaimId), `unknown predecessor claim ${claim.predecessorClaimId}`);
    assert.ok(!predecessors.has(claim.predecessorClaimId), "predecessor claim already reclaimed");
    predecessors.add(claim.predecessorClaimId);
  }

  topologicalOrder(workIds, snapshot.graphEdges);

  for (const edge of snapshot.graphEdges) {
    assert.ok(workIds.has(edge.fromWorkId), `edge references unknown work ${edge.fromWorkId}`);
    assert.ok(workIds.has(edge.toWorkId), `edge references unknown work ${edge.toWorkId}`);
    if (edge.evidenceId) assert.ok(evidenceIds.has(edge.evidenceId), `edge references unknown evidence ${edge.evidenceId}`);
  }

  for (const handoff of snapshot.handoffs) {
    assert.ok(workIds.has(handoff.workId), `handoff references unknown work ${handoff.workId}`);
    assert.ok(agentIds.has(handoff.fromAgentId), `handoff references unknown fromAgentId ${handoff.fromAgentId}`);
    assert.ok(agentIds.has(handoff.toAgentId), `handoff references unknown toAgentId ${handoff.toAgentId}`);
    assert.ok(evidenceIds.has(handoff.evidenceReceiptId), `handoff references unknown evidence ${handoff.evidenceReceiptId}`);
    for (const claimId of handoff.transferClaimIds) assert.ok(claimIds.has(claimId), `handoff references unknown claim ${claimId}`);
    if (handoff.status === "accepted" || handoff.status === "completed") {
      assert.equal(handoff.acceptedBranchHead, handoff.expectedBranchHead, "handoff accepted wrong head");
      assert.ok(
        handoff.newClaimGenerations.every((entry) => entry.generation > entry.previousGeneration),
        "handoff did not acquire new generation",
      );
    }
    if (handoff.status === "completed") {
      assert.ok(handoff.completedAt, "completed handoff lacks completedAt");
    }
  }

  for (const evidence of snapshot.evidence) {
    assert.ok(workIds.has(evidence.workId), `evidence references unknown work ${evidence.workId}`);
    assert.ok(agentIds.has(evidence.producerAgentId), `evidence references unknown producer ${evidence.producerAgentId}`);
    for (const fence of evidence.claimFences) assert.ok(claimIds.has(fence.claimId), `evidence references unknown claim ${fence.claimId}`);
  }

  for (const review of snapshot.reviews) {
    assert.ok(workIds.has(review.workId), `review references unknown work ${review.workId}`);
    assert.ok(agentIds.has(review.reviewerAgentId), `review references unknown reviewer ${review.reviewerAgentId}`);
    for (const evidenceId of review.evidenceIds) assert.ok(evidenceIds.has(evidenceId), `review references unknown evidence ${evidenceId}`);
    for (const authorAgentId of review.reviewedCommitAuthorAgentIds) assert.ok(agentIds.has(authorAgentId), `review references unknown author ${authorAgentId}`);
    const work = snapshot.workItems.find((item) => item.workId === review.workId);
    assertReviewIndependent({
      work,
      review,
      agents: snapshot.agents,
      claims: snapshot.claims,
      registryNow: snapshot.registryNow,
      headSha: review.headSha,
    });
  }

  for (const approval of snapshot.approvals) {
    assert.ok(workIds.has(approval.workId), `approval references unknown work ${approval.workId}`);
    if (approval.decidedBy) assert.ok(approval.allowedHumanIds.includes(approval.decidedBy), "decider is not authorized");
  }

  for (const authority of snapshot.mergeAuthorities) {
    assert.ok(approvalIds.has(authority.approvalId), `merge authority references unknown approval ${authority.approvalId}`);
    assert.ok(agentIds.has(authority.actorId) || /^human:/.test(authority.actorId), `merge authority references unknown actor ${authority.actorId}`);
  }

  let previousEpoch = 0;
  for (const epoch of [...snapshot.authorityEpochs].sort((left, right) => left.epoch - right.epoch)) {
    assert.ok(epoch.epoch > previousEpoch, "authority epochs must be monotonic");
    previousEpoch = epoch.epoch;
    assert.ok(epoch.signatures.length > 0, "authority epoch is unsigned");
    const writeModes = [epoch.githubMode, epoch.forgejoMode].filter((mode) => mode === "write");
    assert.equal(writeModes.length, 1, "exactly one forge write authority is required");
    assert.equal(
      epoch.writeAuthority === "github" ? epoch.githubMode : epoch.forgejoMode,
      "write",
      "writeAuthority and adapter mode disagree",
    );
    if (epoch.writeAuthority === "forgejo") {
      assert.ok(epoch.forgejoBaseUrl, "Forgejo write authority requires forgejoBaseUrl");
      assert.ok(epoch.approvedBy.length >= 2, "Forgejo write authority requires owner and ops approval");
    }
  }
  assert.equal(snapshot.authorityEpoch.epoch, activeAuthorityEpoch(snapshot).epoch, "authorityEpoch must mirror active epoch");
  assertNoMirrorDivergence(snapshot);

  return true;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = `sha256:${"d".repeat(64)}`;
const E = `sha256:${"e".repeat(64)}`;
const WORK = "work:v1:github:elizaOS%2Feliza:issue:16632";
const WORK_2 = "work:v1:github:elizaOS%2Feliza:issue:16436";
const SOL = "agent:v1:elizaOS:sol-orch";
const NUBS = "agent:v1:elizaOS:nubs-agent";
const SHAW = "agent:v1:elizaOS:shaw-agent";
const TEAM_SOL = "team:v1:elizaOS:wakesync";
const TEAM_NUBS = "team:v1:elizaOS:nubs";
const TEAM_SHAW = "team:v1:elizaOS:shaw";
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
      approvedBy: ["human:wakesync", "human:ops"],
      evidenceDigest: D,
      signatures: [{ signer: "human:wakesync", signature: "sig_epoch_1" }],
    },
    authorityEpochs: [
      {
        repoId: "elizaOS/eliza",
        epoch: 1,
        writeAuthority: "github",
        effectiveAt: "2026-07-20T00:00:00.000Z",
        githubMode: "write",
        forgejoMode: "read_mirror",
        approvedBy: ["human:wakesync", "human:ops"],
        evidenceDigest: D,
        signatures: [{ signer: "human:wakesync", signature: "sig_epoch_1" }],
      },
    ],
    teams: [
      { teamId: TEAM_SOL, displayName: "Wakesync", status: "active" },
      { teamId: TEAM_NUBS, displayName: "Nubs", status: "active" },
      { teamId: TEAM_SHAW, displayName: "Shaw", status: "active" },
    ],
    agents: [
      {
        agentId: SOL,
        teamId: TEAM_SOL,
        displayTag: "[sol-orch]",
        independenceGroup: "wakesync-runtime",
        forgePrincipals: ["github-app:wakesync-sol"],
        runtimePrincipal: "runtime:smithers:sol",
        capabilities: ["implementation"],
        authorizedPillars: ["agent-orchestration", "docs-governance"],
        maxConcurrentClaims: 2,
        status: "active",
        registeredBy: "human:wakesync",
      },
      {
        agentId: NUBS,
        teamId: TEAM_NUBS,
        displayTag: "[nubs-agent]",
        independenceGroup: "nubs-runtime",
        forgePrincipals: ["github-app:nubs"],
        runtimePrincipal: "runtime:smithers:nubs",
        capabilities: ["review", "merge"],
        authorizedPillars: ["quality-evidence"],
        maxConcurrentClaims: 2,
        status: "active",
        registeredBy: "human:nubs",
      },
      {
        agentId: SHAW,
        teamId: TEAM_SHAW,
        displayTag: "[shaw-agent]",
        independenceGroup: "shaw-runtime",
        forgePrincipals: ["github-app:shaw"],
        runtimePrincipal: "runtime:smithers:shaw",
        capabilities: ["review"],
        authorizedPillars: ["forge-landing"],
        maxConcurrentClaims: 2,
        status: "active",
        registeredBy: "human:shaw",
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
        aliases: ["github:elizaOS/eliza#16632", "project12:item:PVTI_lad_16632"],
        accountability: [
          { failureClass: "implementation", accountableAgentId: SOL },
          { failureClass: "test_evidence", accountableAgentId: SOL },
          { failureClass: "human_acceptance", accountableHumanId: "human:maintainer" },
          { failureClass: "merge", accountableHumanId: "human:maintainer" },
        ],
        sensitiveClasses: ["merge"],
        smithersRunId: "smithers-p1-16638",
        branchRef: "agent/sol-orch/16632",
        pullRequestRefs: ["github:elizaOS/eliza#16638"],
      },
      {
        workId: WORK_2,
        title: "Quality evidence decision",
        repoId: "elizaOS/eliza",
        pillar: "quality-evidence",
        state: "done",
        targetBranch: "develop",
        paths: ["packages/registry"],
        packages: ["@elizaos/registry"],
        aliases: ["github:elizaOS/eliza#16436"],
        accountability: [
          { failureClass: "implementation", accountableAgentId: NUBS },
          { failureClass: "human_acceptance", accountableHumanId: "human:wakesync" },
        ],
        sensitiveClasses: [],
        pullRequestRefs: [],
      },
    ],
    lifecycleTransitions: [
      {
        workId: WORK,
        from: "in_progress",
        to: "needs_agent_review",
        actorId: SOL,
        at: "2026-07-20T06:18:00.000Z",
        receiptId: "receipt_transition_review",
      },
    ],
    resourceFences: [
      {
        resourceKey: "elizaOS/eliza:path:plugins/plugin-agent-orchestrator",
        currentGeneration: 3,
        updatedAt: "2026-07-20T06:20:00.000Z",
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
    handoffs: [
      {
        handoffId: "handoff_review",
        workId: WORK,
        fromAgentId: SOL,
        toAgentId: NUBS,
        expectedBranchHead: B,
        acceptedBranchHead: B,
        smithersRunId: "smithers-p1-16638",
        lastCompletedFrame: "test",
        evidenceReceiptId: "evidence_smithers",
        transferClaimIds: ["claim_smithers_review"],
        newClaimGenerations: [{ claimId: "claim_smithers_review", previousGeneration: 2, generation: 3 }],
        risks: ["manual merge required"],
        nextAction: "independent review",
        status: "completed",
        offeredAt: "2026-07-20T06:19:00.000Z",
        acceptedAt: "2026-07-20T06:20:00.000Z",
        completedAt: "2026-07-20T06:21:00.000Z",
        expiresAt: "2026-07-20T07:10:00.000Z",
      },
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
        negativeCases: ["GAP regression suite rejects invalid states"],
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
        reviewedPaths: ["plugins/plugin-agent-orchestrator"],
        failureClasses: ["implementation", "test_evidence"],
        verdict: "approve",
        findings: [],
        evidenceIds: ["evidence_smithers"],
        reviewedCommitAuthorAgentIds: [SOL],
        activeWriteClaimIdsAtReview: [],
        createdAt: "2026-07-20T06:29:00.000Z",
      },
    ],
    approvals: [
      {
        approvalId: "approval_merge",
        workId: WORK,
        failureClasses: ["merge"],
        action: "merge",
        environment: "github:develop",
        headSha: B,
        riskDigest: D,
        status: "approved",
        allowedActorId: NUBS,
        allowedHumanIds: ["human:maintainer"],
        decidedBy: "human:maintainer",
        requestedAt: "2026-07-20T06:20:00.000Z",
        decidedAt: "2026-07-20T06:25:00.000Z",
        expiresAt: "2026-07-20T07:00:00.000Z",
        oneShot: true,
      },
    ],
    mergeAuthorities: [
      {
        mergeAuthorityId: "merge_auth_nubs",
        repoId: "elizaOS/eliza",
        targetBranch: "develop",
        actorId: NUBS,
        scope: "governance-docs",
        epoch: 1,
        signer: "human:maintainer",
        approvalId: "approval_merge",
        status: "active",
        grantedAt: "2026-07-20T06:25:00.000Z",
        expiresAt: "2026-07-20T07:00:00.000Z",
      },
    ],
    mirrorStates: [
      {
        repoId: "elizaOS/eliza",
        authority: "github",
        mirror: "forgejo",
        authorityHeadSha: B,
        mirrorHeadSha: B,
        authorityWorkId: WORK,
        mirrorWorkId: WORK,
        observedAt: "2026-07-20T06:28:00.000Z",
      },
    ],
    smithersExternalWriteReceipts: [
      {
        frameId: "frame_push",
        workId: WORK,
        idempotencyKey: "push:work:16632:head-b",
        targetSystem: "github",
        mutation: "push",
        status: "recorded",
        recordedAt: "2026-07-20T06:14:00.000Z",
      },
    ],
  };
}

test("Draft 2020-12 JSON Schema validates the canonical snapshot", () => {
  assertDraft202012Valid(fixture());
});

test("valid federated snapshot passes semantic conformance", () => {
  assert.equal(validateSnapshot(fixture()), true);
});

test("requirement 1: canonical workId parsing and alias preservation", () => {
  const value = fixture();
  assert.deepEqual(parseWorkId(WORK), {
    authority: "github",
    repoId: "elizaOS/eliza",
    kind: "issue",
    nativeId: "16632",
  });
  value.workItems[0].aliases = [];
  assert.throws(() => validateSnapshot(value), /should be non-empty|is too short|has no preserved alias/);
});

test("requirement 2: identity uniqueness and lane-tag non-authority", () => {
  const value = fixture();
  value.agents[2].displayTag = value.agents[0].displayTag;
  assert.throws(() => validateSnapshot(value), /duplicate displayTag|has non-unique elements/);
});

test("requirement 3: exactly one accountable owner per failure class", () => {
  const value = fixture();
  value.workItems[0].accountability.push({
    failureClass: "implementation",
    accountableAgentId: NUBS,
  });
  assert.throws(() => validateSnapshot(value), /duplicate accountability/);
});

test("requirement 4: active exclusive lease blocks overlap", () => {
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

test("requirement 5: path overlap is segment aware", () => {
  assert.equal(pathOverlaps("packages/app", "packages/app/src/a.ts"), true);
  assert.equal(pathOverlaps("./packages/app/", "packages/app"), true);
  assert.equal(pathOverlaps("packages/app", "packages/app-old/src/a.ts"), false);
});

test("requirement 6: expiry and reclamation increment resource generation by CAS", () => {
  const old = {
    ...fixture().claims[0],
    status: "active",
    mode: "exclusive",
    generation: 8,
    expiresAt: "2026-07-20T06:29:59.000Z",
  };
  const registry = {
    claims: [old],
    resourceFences: new Map([[resourceKey(old.repoId, old.resources[0]), { generation: 8 }]]),
    reclaimedPredecessors: new Set(),
  };
  const next = reclaimClaimAtomic(
    registry,
    old.claimId,
    {
      claimId: "claim_successor",
      ownerAgentId: SOL,
      ownerSessionId: `session:v1:${SOL}:r3`,
      expiresAt: "2026-07-20T06:50:00.000Z",
    },
    NOW,
  );
  assert.equal(next.generation, 9);
  assert.throws(() => assertFence(next, 8, NOW), /stale_fence/);
  assert.doesNotThrow(() => assertFence(next, 9, NOW));
});

test("requirement 7: stale-fence writes are rejected", () => {
  const claim = fixture().claims[0];
  assert.throws(() => assertFence(claim, claim.generation - 1, NOW), /stale_fence/);
});

test("requirement 8: no-progress renewal becomes suspect", () => {
  const claim = { ...fixture().claims[0], mode: "exclusive", noProgressRenewals: 2 };
  const renewed = renewClaim(claim, { now: NOW });
  assert.equal(renewed.status, "suspect");
});

test("requirement 9: hard dependency cycles are rejected", () => {
  const ids = new Set([WORK, WORK_2]);
  assert.throws(
    () =>
      topologicalOrder(ids, [
        { fromWorkId: WORK, toWorkId: WORK_2, type: "requires" },
        { fromWorkId: WORK_2, toWorkId: WORK, type: "stacks_on" },
      ]),
    /hard dependency cycle/,
  );
});

test("requirement 10: deterministic topological order uses inverse blocks direction", () => {
  const ids = new Set([WORK, WORK_2]);
  assert.deepEqual(
    topologicalOrder(ids, [
      { fromWorkId: WORK, toWorkId: WORK_2, type: "requires" },
    ]),
    [WORK_2, WORK],
  );
  assert.deepEqual(
    topologicalOrder(ids, [
      { fromWorkId: WORK, toWorkId: WORK_2, type: "blocks" },
    ]),
    [WORK, WORK_2],
  );
});

test("requirement 11: collision winner is deterministic", () => {
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

test("requirement 12: handoff requires matching head and new generation", () => {
  const value = fixture();
  value.handoffs[0].acceptedBranchHead = C;
  assert.throws(() => validateSnapshot(value), /handoff accepted wrong head/);
  value.handoffs[0].acceptedBranchHead = B;
  value.handoffs[0].newClaimGenerations[0].generation = 2;
  assert.throws(() => validateSnapshot(value), /new generation/);
});

test("requirement 13: terminal work cannot retain an active claim", () => {
  const value = fixture();
  value.workItems[0].state = "done";
  assert.throws(() => validateSnapshot(value), /terminal work retains active claim/);
});

test("requirement 14: same agent, session, team, and independence group reviews are rejected", () => {
  const value = fixture();
  assert.throws(
    () =>
      assertReviewIndependent({
        work: value.workItems[0],
        review: { ...value.reviews[0], reviewerAgentId: SOL, independenceGroup: "wakesync-runtime" },
        agents: value.agents,
        claims: value.claims,
        registryNow: NOW,
        headSha: B,
      }),
    /self review|same team|not independent/,
  );
});

test("requirement 15: changed-head review invalidates approval", () => {
  const value = fixture();
  assert.throws(
    () =>
      assertReviewIndependent({
        work: value.workItems[0],
        review: value.reviews[0],
        agents: value.agents,
        claims: value.claims,
        registryNow: NOW,
        headSha: C,
      }),
    /review is stale/,
  );
});

test("requirement 16: sensitive work requires exact, authorized, atomic HITL approval", () => {
  const value = fixture();
  const work = value.workItems[0];
  const request = {
    actorId: NUBS,
    headSha: B,
    action: "merge",
    environment: "github:develop",
    riskDigest: D,
    executedAt: NOW,
  };
  assert.equal(approvalCovers(work, value.approvals[0], NOW, request), true);
  consumeApproval(value.approvals[0], request);
  assert.equal(value.approvals[0].status, "consumed");
  assert.throws(() => consumeApproval(value.approvals[0], request), /not approved/);
});

test("requirement 17: implementation ownership does not confer merge authority", () => {
  const value = fixture();
  const work = value.workItems[0];
  assert.throws(
    () =>
      assertMergePreflight({
        work,
        actorId: SOL,
        headSha: B,
        requiredChecks: [{ name: "test", status: "success" }],
        mergeAuthorities: value.mergeAuthorities,
        approvals: value.approvals,
        registryNow: NOW,
      }),
    /implementation ownership confers no merge authority/,
  );
});

test("requirement 18: Smithers external-write replay barrier is idempotent", () => {
  assert.doesNotThrow(() =>
    assertExternalWriteBarrier({
      frame: { replayable: false, idempotencyKey: "push:work:16632:head-b" },
      receipt: { idempotencyKey: "push:work:16632:head-b", status: "recorded" },
      idempotencyKey: "push:work:16632:head-b",
    }),
  );
  assert.throws(
    () =>
      assertExternalWriteBarrier({
        frame: { replayable: true, idempotencyKey: "push:work:16632:head-b" },
        receipt: { idempotencyKey: "push:work:16632:head-b", status: "recorded" },
        idempotencyKey: "push:work:16632:head-b",
      }),
    /must not be replayable/,
  );
});

test("requirement 19: one active forge write authority per signed monotonic epoch", () => {
  const value = fixture();
  value.authorityEpochs.push({
    ...value.authorityEpochs[0],
    epoch: 2,
    writeAuthority: "forgejo",
    effectiveAt: "2026-07-20T06:00:00.000Z",
    githubMode: "read_mirror",
    forgejoMode: "write",
    forgejoBaseUrl: "https://git.example.org",
    approvedBy: ["human:wakesync", "human:ops"],
    signatures: [{ signer: "human:ops", signature: "sig_epoch_2" }],
  });
  value.authorityEpoch = value.authorityEpochs[1];
  assert.equal(validateSnapshot(value), true);
  assert.throws(
    () => assertForgeWriteAllowed(value, { forge: "github", epoch: 1, at: NOW, workId: WORK, commitWorkId: WORK }),
    /stale authority epoch/,
  );
});

test("requirement 20: GitHub/Forgejo mirror divergence is detected", () => {
  const value = fixture();
  value.mirrorStates[0].mirrorHeadSha = C;
  assert.throws(() => validateSnapshot(value), /mirror divergence/);
});

test("GAP: same owner cannot hold overlapping live review and exclusive claims", () => {
  const value = fixture();
  value.claims.push({
    ...value.claims[0],
    claimId: "claim_same_owner_write",
    mode: "exclusive",
  });
  assert.throws(() => validateSnapshot(value), /overlapping active claims/);
});

test("GAP: two agents cannot share the same authenticated forge principal", () => {
  const value = fixture();
  value.agents[1].forgePrincipals = value.agents[0].forgePrincipals;
  assert.throws(() => validateSnapshot(value), /duplicate forge principal/);
});

test("GAP: ownerSessionId must belong to ownerAgentId", () => {
  const value = fixture();
  value.claims[0].ownerSessionId = `session:v1:${SOL}:foreign`;
  assert.throws(() => validateSnapshot(value), /ownerSessionId does not belong/);
});

test("GAP: maxConcurrentClaims is enforced", () => {
  const value = fixture();
  value.agents[1].maxConcurrentClaims = 1;
  value.claims.push({
    ...value.claims[0],
    claimId: "claim_second_nonoverlap",
    resources: [{ kind: "path", id: "docs" }],
  });
  value.resourceFences.push({
    resourceKey: "elizaOS/eliza:path:docs",
    currentGeneration: 3,
    updatedAt: NOW,
  });
  assert.throws(() => validateSnapshot(value), /maxConcurrentClaims exceeded/);
});

test("GAP: same-team review fails even when independence groups differ", () => {
  const value = fixture();
  value.agents[1].teamId = TEAM_SOL;
  assert.throws(() => validateSnapshot(value), /same team review/);
});

test("GAP: receipt independenceGroup must match registered group", () => {
  const value = fixture();
  value.reviews[0].independenceGroup = "forged-group";
  assert.throws(() => validateSnapshot(value), /independenceGroup disagrees/);
});

test("GAP: reviews reject authored commits and active write leases", () => {
  const value = fixture();
  value.reviews[0].reviewedCommitAuthorAgentIds.push(NUBS);
  assert.throws(() => validateSnapshot(value), /reviewer authored/);
  const activeWrite = fixture();
  activeWrite.claims[0].mode = "exclusive";
  activeWrite.reviews[0].activeWriteClaimIdsAtReview = ["claim_smithers_review"];
  assert.throws(() => validateSnapshot(activeWrite), /reviewer held write lease|active mutation lease|overlapping active claims/);
});

test("GAP: requires and blocks use inverse topological direction", () => {
  const ids = new Set([WORK, WORK_2]);
  assert.deepEqual(
    topologicalOrder(ids, [{ fromWorkId: WORK, toWorkId: WORK_2, type: "requires" }]),
    [WORK_2, WORK],
  );
  assert.deepEqual(
    topologicalOrder(ids, [{ fromWorkId: WORK, toWorkId: WORK_2, type: "blocks" }]),
    [WORK, WORK_2],
  );
});

test("GAP: two successors cannot reclaim the same expired claim", () => {
  const old = {
    ...fixture().claims[0],
    status: "active",
    mode: "exclusive",
    generation: 8,
    expiresAt: "2026-07-20T06:29:59.000Z",
  };
  const registry = {
    claims: [old],
    resourceFences: new Map([[resourceKey(old.repoId, old.resources[0]), { generation: 8 }]]),
    reclaimedPredecessors: new Set(),
  };
  reclaimClaimAtomic(registry, old.claimId, {
    claimId: "claim_successor_one",
    ownerAgentId: SOL,
    ownerSessionId: `session:v1:${SOL}:r3`,
    expiresAt: "2026-07-20T06:50:00.000Z",
  }, NOW);
  assert.throws(
    () =>
      reclaimClaimAtomic(registry, old.claimId, {
        claimId: "claim_successor_two",
        ownerAgentId: SHAW,
        ownerSessionId: `session:v1:${SHAW}:r4`,
        expiresAt: "2026-07-20T06:50:00.000Z",
      }, NOW),
    /already reclaimed/,
  );
});

test("GAP: HITL decidedBy must be in allowedHumanIds", () => {
  const value = fixture();
  value.approvals[0].decidedBy = "human:intruder";
  assert.throws(() => validateSnapshot(value), /decider is not authorized/);
});

test("GAP: work aliases cannot be empty", () => {
  const value = fixture();
  value.workItems[0].aliases = [""];
  assert.throws(() => validateSnapshot(value), /should be non-empty|is too short/);
});

test("GAP: reviews and approvals reject unknown work or evidence references", () => {
  const value = fixture();
  value.reviews[0].evidenceIds = ["evidence_missing"];
  assert.throws(() => validateSnapshot(value), /unknown evidence/);
  const badApproval = fixture();
  badApproval.approvals[0].workId = "work:v1:github:elizaOS%2Feliza:issue:99999";
  assert.throws(() => validateSnapshot(badApproval), /unknown work/);
});

test("GAP: Forgejo write authority requires URL and owner plus ops approval", () => {
  const value = fixture();
  value.authorityEpochs[0] = {
    ...value.authorityEpochs[0],
    writeAuthority: "forgejo",
    githubMode: "read_mirror",
    forgejoMode: "write",
    approvedBy: ["human:wakesync"],
  };
  value.authorityEpoch = value.authorityEpochs[0];
  assert.throws(() => validateSnapshot(value), /forgejoBaseUrl|required property|owner and ops/);
});

test("GAP: handoff and lifecycle transitions are normative schema objects", () => {
  assert.ok(SCHEMA.$defs.handoff, "missing handoff definition");
  assert.ok(SCHEMA.$defs.lifecycleTransition, "missing lifecycleTransition definition");
  const value = fixture();
  value.handoffs[0].status = "accepted";
  value.handoffs[0].acceptedBranchHead = C;
  assert.throws(() => validateSnapshot(value), /handoff accepted wrong head/);
});
