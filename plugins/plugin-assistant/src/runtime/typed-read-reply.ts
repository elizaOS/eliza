/** Canonical opt-in typed public-read validation; producer facts remain the only evidence authority. */
import type {
  EvaluatorOutput,
  TypedReadEgressReceipt,
  TypedReadFact,
  TypedReadReplyBinding,
  TypedReadReplyPart,
  TypedReadReplyPolicy,
  TypedReadReplyVerdict,
} from "@elizaos/core";

export const typedReadPartsSchema = {
  type: "array",
  items: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["fact", "qualified"] },
          requirementId: { type: "string" },
          factId: { type: "string" },
          value: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
        required: ["kind", "requirementId", "factId", "value"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["unverified"] },
          requirementId: { type: "string" },
        },
        required: ["kind", "requirementId"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["connector"] },
          connectorId: { type: "string" },
        },
        required: ["kind", "connectorId"],
      },
    ],
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function day(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/**
 * Facts and policy are host-owned projections of existing action results.
 * This function never mines raw JSON, admits a source, or proves arbitrary prose.
 * An absent policy leaves ordinary conversation unchanged. A rejected draft must
 * re-enter the existing evaluator correction path or end with an honest refusal.
 */
function renderTypedReadParts(input: {
  parts: unknown;
  policy: TypedReadReplyPolicy;
  facts: readonly TypedReadFact[];
}): TypedReadReplyVerdict {
  const { policy, facts } = input;
  const reject = (
    reason: Extract<TypedReadReplyVerdict, { verdict: "reject" }>["reason"],
  ): TypedReadReplyVerdict => ({ verdict: "reject", reason });
  if (
    !policy.ownerScope ||
    typeof policy.turnId !== "string" ||
    !policy.turnId.trim() ||
    !Number.isFinite(policy.nowMs) ||
    policy.requirements.length === 0 ||
    policy.requirements.some(
      (r) =>
        !r.id ||
        !r.label.trim() ||
        !r.unverifiedText.trim() ||
        !Array.isArray(r.admittedFactIds) ||
        new Set(r.admittedFactIds).size !== r.admittedFactIds.length ||
        r.admittedFactIds.some((id) => typeof id !== "string" || !id) ||
        (r.qualifiedFactIds !== undefined &&
          (!Array.isArray(r.qualifiedFactIds) ||
            new Set(r.qualifiedFactIds).size !== r.qualifiedFactIds.length ||
            r.qualifiedFactIds.some((id) => typeof id !== "string" || !id))),
    ) ||
    new Set(policy.requirements.map((r) => r.id)).size !==
      policy.requirements.length ||
    new Set(facts.map((f) => f.id)).size !== facts.length
  )
    return reject("invalid-contract");
  if (!Array.isArray(input.parts) || input.parts.length === 0)
    return reject("missing-claim-declaration");
  const requirements = new Map(policy.requirements.map((r) => [r.id, r]));
  const knownFacts = new Map(facts.map((f) => [f.id, f]));
  const covered = new Set<string>();
  const used: string[] = [];
  const rendered: string[] = [];
  let partial = false;
  let connectorSinceClaim = false;
  for (const part of input.parts) {
    if (!record(part)) return reject("invalid-contract");
    if (part.kind === "connector") {
      if (
        Object.keys(part).sort().join(",") !== "connectorId,kind" ||
        typeof part.connectorId !== "string" ||
        !Object.hasOwn(policy.connectors, part.connectorId)
      )
        return reject("unknown-reference");
      rendered.push(policy.connectors[part.connectorId]);
      connectorSinceClaim = true;
      continue;
    }
    if (typeof part.requirementId !== "string")
      return reject("unknown-reference");
    const requirement = requirements.get(part.requirementId);
    if (!requirement || covered.has(requirement.id))
      return reject("unknown-reference");
    if (covered.size > 0 && !connectorSinceClaim) rendered.push("\n\n");
    connectorSinceClaim = false;
    covered.add(requirement.id);
    if (part.kind === "unverified") {
      if (Object.keys(part).sort().join(",") !== "kind,requirementId")
        return reject("invalid-contract");
      rendered.push(requirement.unverifiedText);
      partial = true;
      continue;
    }
    if (
      (part.kind !== "fact" && part.kind !== "qualified") ||
      Object.keys(part).sort().join(",") !==
        "factId,kind,requirementId,value" ||
      typeof part.factId !== "string"
    )
      return reject("invalid-contract");
    const fact = knownFacts.get(part.factId);
    if (
      !fact ||
      !(
        part.kind === "qualified"
          ? (requirement.qualifiedFactIds ?? [])
          : requirement.admittedFactIds
      ).includes(fact.id)
    )
      return reject("unknown-reference");
    if (fact.ownerScope !== policy.ownerScope) return reject("owner-mismatch");
    if (part.kind === "qualified") {
      if (fact.kind === "quantity-report" && requirement.kind === "quantity") {
        const locality = fact.providerLocality;
        if (
          !Number.isFinite(fact.value) ||
          fact.value !== part.value ||
          fact.unit !== requirement.unit ||
          (fact.reportedDay !== undefined && !day(fact.reportedDay)) ||
          (locality !== undefined &&
            (typeof locality !== "string" ||
              locality.length === 0 ||
              locality.length > 128 ||
              locality.trim() !== locality ||
              !/^[-\p{L}\p{M}\p{N}\p{Zs}.'’(),&/]+$/u.test(locality) ||
              !/\p{L}/u.test(locality)))
        )
          return reject("unsupported-value");
        if (fact.qualification === "named-place-alternative") {
          const age =
            fact.observedAtMs === undefined
              ? NaN
              : policy.nowMs - fact.observedAtMs;
          if (
            !locality ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > requirement.freshnessMs
          )
            return reject("unverified-time");
          rendered.push(`${locality}: ${fact.value}${fact.unit}.`);
        } else {
          rendered.push(
            `${requirement.label}: a nearby report${locality ? ` for ${locality}` : ""}${fact.reportedDay ? ` dated ${fact.reportedDay}` : ""} says ${fact.value}${fact.unit}. ${requirement.unverifiedText}`,
          );
        }
      } else if (
        fact.kind === "publication-report" &&
        requirement.kind === "publication"
      ) {
        if (
          !fact.title.trim() ||
          part.value !== fact.title ||
          !day(fact.publicationDay) ||
          (requirement.requestedDay !== undefined &&
            fact.publicationDay >= requirement.requestedDay)
        )
          return reject("unsupported-value");
        rendered.push(
          `${requirement.label}: ${fact.title} (dated ${fact.publicationDay}). ${requirement.unverifiedText}`,
        );
      } else return reject("unsupported-value");
      if (policy.includeSources) rendered.push(` ${fact.sourceUrl}`);
      partial = true;
      used.push(fact.id);
      continue;
    }
    if (fact.kind !== requirement.kind) return reject("unsupported-value");
    if (fact.kind === "quantity" && requirement.kind === "quantity") {
      if (
        !Number.isFinite(requirement.freshnessMs) ||
        requirement.freshnessMs < 0 ||
        !Number.isFinite(fact.value) ||
        part.value !== fact.value ||
        fact.unit !== requirement.unit
      )
        return reject("unsupported-value");
      const estimate = fact.modelEstimate;
      if (estimate) {
        const accepted = requirement.modelEstimate;
        if (
          !accepted ||
          fact.observedAtMs !== undefined ||
          !Object.hasOwn(policy.connectors, estimate.creditConnectorId) ||
          !Number.isFinite(accepted.maxSourceAgeMs) ||
          accepted.maxSourceAgeMs < 0 ||
          !Number.isFinite(accepted.maxValidDistanceMs) ||
          accepted.maxValidDistanceMs < 0 ||
          !Number.isFinite(accepted.futureSkewMs) ||
          accepted.futureSkewMs < 0 ||
          !Number.isFinite(estimate.validAtMs) ||
          !Number.isFinite(estimate.modelUpdatedAtMs) ||
          policy.nowMs - estimate.modelUpdatedAtMs > accepted.maxSourceAgeMs ||
          estimate.modelUpdatedAtMs > policy.nowMs + accepted.futureSkewMs ||
          Math.abs(policy.nowMs - estimate.validAtMs) >
            accepted.maxValidDistanceMs
        )
          return reject("unverified-time");
        rendered.push(
          `${requirement.label}: ${fact.value}${fact.unit} (model estimate; ${policy.connectors[estimate.creditConnectorId]}).`,
        );
      } else {
        const age =
          fact.observedAtMs === undefined
            ? null
            : policy.nowMs - fact.observedAtMs;
        if (
          requirement.current &&
          (age === null ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > requirement.freshnessMs)
        )
          return reject("unverified-time");
        rendered.push(
          requirement.current
            ? `${requirement.label}: ${fact.value}${fact.unit}.`
            : `${requirement.label}: a report says ${fact.value}${fact.unit}; I couldn't verify how recent it is.`,
        );
        if (!requirement.current) partial = true;
      }
    } else if (
      fact.kind === "publication" &&
      requirement.kind === "publication"
    ) {
      if (!fact.title.trim() || part.value !== fact.title)
        return reject("unsupported-value");
      if (
        requirement.requestedDay &&
        (!day(requirement.requestedDay) ||
          !fact.publicationDay ||
          !day(fact.publicationDay) ||
          fact.publicationDay !== requirement.requestedDay)
      )
        return reject("unverified-time");
      rendered.push(`${requirement.label}: ${fact.title}`);
    } else return reject("unsupported-value");
    if (policy.includeSources) rendered.push(` ${fact.sourceUrl}`);
    used.push(fact.id);
  }
  if (covered.size !== requirements.size)
    return reject("missing-claim-declaration");
  return {
    verdict: "allow",
    text: rendered.join(""),
    factIds: used,
    ...(partial ? { partial: true as const } : {}),
  };
}

export function evaluateTypedReadReply(input: {
  text: string;
  parts: unknown;
  policy?: TypedReadReplyPolicy;
  facts: readonly TypedReadFact[];
}): TypedReadReplyVerdict {
  if (!input.policy) return { verdict: "not-applicable", text: input.text };
  const rendered = renderTypedReadParts({ ...input, policy: input.policy });
  if (rendered.verdict === "allow" && rendered.text !== input.text)
    return { verdict: "reject", reason: "draft-not-bound" };
  return rendered;
}

/** Validated source facts for each requested part; no claim is inferred from a draft. */
export function availableTypedReadFacts(
  policy: TypedReadReplyPolicy,
  facts: readonly TypedReadFact[],
): Map<string, TypedReadFact> {
  const known = new Map(facts.map((fact) => [fact.id, fact]));
  const available = new Map<string, TypedReadFact>();
  if (known.size !== facts.length) return available;
  for (const requirement of policy.requirements) {
    for (const id of requirement.admittedFactIds) {
      const fact = known.get(id);
      if (!fact) continue;
      const part: TypedReadReplyPart = {
        kind: "fact",
        requirementId: requirement.id,
        factId: id,
        value:
          fact.kind === "quantity" || fact.kind === "quantity-report"
            ? fact.value
            : fact.title,
      };
      // Reuse the same mechanical evidence validation for this requirement.
      const checked = renderTypedReadParts({
        policy: { ...policy, requirements: [requirement] },
        facts: [fact],
        parts: [part],
      });
      if (checked.verdict === "allow") {
        available.set(requirement.id, fact);
        break;
      }
    }
  }
  return available;
}

/** Validates alternative evidence without treating it as full requirement fulfillment. */
function availableQualifiedReadFacts(
  policy: TypedReadReplyPolicy,
  facts: readonly TypedReadFact[],
): Map<string, TypedReadFact> {
  const available = new Map<string, TypedReadFact>();
  const known = new Map(facts.map((fact) => [fact.id, fact]));
  if (known.size !== facts.length) return available;
  for (const requirement of policy.requirements)
    for (const id of requirement.qualifiedFactIds ?? []) {
      const fact = known.get(id);
      if (!fact) continue;
      const checked = renderTypedReadParts({
        policy: { ...policy, requirements: [requirement] },
        facts: [fact],
        parts: [
          {
            kind: "qualified",
            requirementId: requirement.id,
            factId: id,
            value:
              fact.kind === "quantity" || fact.kind === "quantity-report"
                ? fact.value
                : fact.title,
          },
        ],
      });
      if (checked.verdict === "allow") {
        available.set(requirement.id, fact);
        break;
      }
    }
  return available;
}

/** Emits only supported typed parts and host-owned uncertainty; never promotes a draft. */
export function partialTypedReadReply(
  output: EvaluatorOutput,
  binding: TypedReadReplyBinding,
): EvaluatorOutput {
  const available = availableTypedReadFacts(binding.policy, binding.facts);
  const alternatives = availableQualifiedReadFacts(
    binding.policy,
    binding.facts,
  );
  const parts: TypedReadReplyPart[] = [];
  const separator = Object.keys(binding.policy.connectors).find(
    (key) => binding.policy.connectors[key] === "\n\n",
  );
  for (const requirement of binding.policy.requirements) {
    if (parts.length && separator)
      parts.push({ kind: "connector", connectorId: separator });
    const fact =
      available.get(requirement.id) ?? alternatives.get(requirement.id);
    parts.push(
      fact
        ? {
            kind: available.has(requirement.id) ? "fact" : "qualified",
            requirementId: requirement.id,
            factId: fact.id,
            value:
              fact.kind === "quantity" || fact.kind === "quantity-report"
                ? fact.value
                : fact.title,
          }
        : { kind: "unverified", requirementId: requirement.id },
    );
  }
  const rendered = renderTypedReadParts({
    policy: binding.policy,
    facts: binding.facts,
    parts,
  });
  return {
    ...output,
    success: false,
    requestFullyCovered: false,
    replyEffectStatus: "none",
    decision: "FINISH",
    nextTool: undefined,
    recommendedToolCallId: undefined,
    copyToClipboard: undefined,
    typedReadRejected: undefined,
    thought:
      "Only verified read evidence and explicit uncertainty can be returned.",
    messageToUser:
      rendered.verdict === "allow"
        ? rendered.text
        : "I couldn't verify that from the available information.",
    typedReadValidatedParts: rendered.verdict === "allow" ? parts : undefined,
    ...(rendered.verdict === "allow"
      ? { typedReadRendered: true as const }
      : {}),
    parseError: "typed-read:missing-evidence",
  };
}

/** Applies the opt-in gate at the existing evaluator's pre-egress boundary. */
export function applyTypedReadReply(
  output: EvaluatorOutput,
  binding?: TypedReadReplyBinding,
  correctionAlreadyRequested = false,
): EvaluatorOutput {
  if (
    !binding ||
    (binding.phase === "planning" && output.decision !== "FINISH")
  )
    return output;
  const verdict =
    output.decision === "FINISH"
      ? renderTypedReadParts({
          parts: output.typedReadValidatedParts ?? output.raw?.typedReadParts,
          policy: binding.policy,
          facts: binding.facts,
        })
      : { verdict: "reject" as const, reason: "nonfinal-answer" as const };
  if (verdict.verdict === "allow") {
    // Revalidate freshness above on every cache read, but retain the shared
    // lifecycle result when its rendered answer and egress are unchanged.
    if (
      output.typedReadRendered === true &&
      output.messageToUser === verdict.text &&
      (!verdict.partial || output.success === false) &&
      output.copyToClipboard === undefined &&
      output.nextTool === undefined &&
      output.recommendedToolCallId === undefined
    )
      return output;
    return {
      ...output,
      messageToUser: verdict.text,
      success: verdict.partial ? false : output.success,
      requestFullyCovered: verdict.partial ? false : output.requestFullyCovered,
      replyEffectStatus: "none",
      copyToClipboard: undefined,
      nextTool: undefined,
      recommendedToolCallId: undefined,
      typedReadRendered: true,
    };
  }
  if (verdict.verdict !== "reject") return output;
  return {
    ...output,
    success: false,
    decision: correctionAlreadyRequested ? "FINISH" : "CONTINUE",
    messageToUser: correctionAlreadyRequested
      ? "I couldn't verify that from the available information."
      : undefined,
    thought: `Typed read evidence rejected the final draft (${verdict.reason}); preserve completed tool results and correct only the answer.`,
    parseError: `typed-read:${verdict.reason}`,
    typedReadRejected: true,
    copyToClipboard: undefined,
    nextTool: undefined,
    recommendedToolCallId: undefined,
  };
}

interface TypedReadEgressProof {
  policy: TypedReadReplyPolicy;
  facts: readonly TypedReadFact[];
  parts: unknown;
  text: string;
}
const typedReadEgressProofs = new WeakMap<object, TypedReadEgressProof>();

/** Minted only after the producer-backed parts render to the exact terminal text. */
export function createTypedReadEgressReceipt(
  output: EvaluatorOutput,
  binding: TypedReadReplyBinding,
): TypedReadEgressReceipt | undefined {
  if (
    output.decision !== "FINISH" ||
    output.typedReadRendered !== true ||
    typeof output.messageToUser !== "string"
  )
    return undefined;
  const proof = structuredClone({
    policy: { ...binding.policy, nowMs: Date.now() },
    facts: binding.facts,
    parts: output.typedReadValidatedParts ?? output.raw?.typedReadParts,
    text: output.messageToUser,
  });
  const verdict = evaluateTypedReadReply(proof);
  if (verdict.verdict !== "allow" || verdict.factIds.length === 0)
    return undefined;
  const receipt: TypedReadEgressReceipt = Object.freeze({
    version: 1,
    ownerScope: proof.policy.ownerScope,
    turnId: proof.policy.turnId,
    requirementIds: Object.freeze(
      proof.policy.requirements.map((item) => item.id),
    ),
    factIds: Object.freeze([...verdict.factIds]),
    partial: verdict.partial === true,
  });
  typedReadEgressProofs.set(receipt, proof);
  return receipt;
}

/** Serialized, cloned or model-authored lookalikes cannot bypass a host's legacy boundary. */
export function verifyTypedReadEgressReceipt(
  receipt: unknown,
  expected: {
    ownerScope: string;
    turnId: string;
    requirementIds: readonly string[];
    reply: string;
    nowMs?: number;
  },
): receipt is TypedReadEgressReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const proof = typedReadEgressProofs.get(receipt);
  if (
    !proof ||
    proof.policy.ownerScope !== expected.ownerScope ||
    proof.policy.turnId !== expected.turnId ||
    proof.text !== expected.reply ||
    proof.policy.requirements.length !== expected.requirementIds.length ||
    proof.policy.requirements.some(
      (requirement, index) => requirement.id !== expected.requirementIds[index],
    )
  )
    return false;
  const checked = evaluateTypedReadReply({
    ...proof,
    policy: { ...proof.policy, nowMs: expected.nowMs ?? Date.now() },
  });
  return checked.verdict === "allow";
}
