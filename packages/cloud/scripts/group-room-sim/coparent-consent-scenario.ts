/**
 * Defines the deterministic co-parent consent choreography and its
 * machine-readable evidence ledger. The CI adapter supplies production-backed
 * repository, route, gateway, provider, and memory observations; this module
 * owns ordering and cross-seam invariants without contacting a live service.
 */

export type ScenarioActor =
  | "Parent A"
  | "Parent B"
  | "Child C"
  | "Eliza"
  | "system";
export type ScenarioChannel =
  | "group"
  | "parent_a_dm"
  | "parent_b_dm"
  | "repository";

export type JoinAttackVector =
  | "forged"
  | "expired"
  | "replayed"
  | "wrong_sender"
  | "wrong_binding"
  | "cross_thread";

export interface ConsentSnapshot {
  mode: "single_owner" | "all_adults";
  gate: "enabled" | "restricted";
  requiredPrincipalCount: number;
  registeredParticipantCount: number;
  linkedParticipantCount: number;
  consentedParticipantCount: number;
  linkedPrincipalIds: string[];
  consentProvenances: string[];
  participants: Array<{
    ordinal: number;
    isOwner: boolean;
    linked: boolean;
    consented: boolean;
    revoked: boolean;
  }>;
}

export interface BindingObservation {
  bindingId: string;
  conversationId: string;
  status: "bound";
  consent: ConsentSnapshot;
  routeStages?: string[];
}

export interface JoinAttackObservation {
  vector: JoinAttackVector;
  accepted: boolean;
  status: string;
  routeStages?: string[];
  scopeRejectionSeam?: "repository";
}

export interface TurnObservation {
  code: string;
  reply: string;
  roomId: string;
  mediaUrlCount: number;
  mediaEnrichmentExecuted: boolean;
  runtimePrewarmExecuted: boolean;
  capabilityExecuted: boolean;
}

export interface MemoryIsolationObservation {
  groupRoomId: string;
  parentADmRoomId: string;
  parentBDmRoomId: string;
  groupRecall: string[];
  parentADmRecall: string[];
  parentBDmRecall: string[];
  expectedGroupMarker: string;
  expectedParentAMarker: string;
  expectedParentBMarker: string;
}

export interface ExactlyOnceObservation {
  inboundAttempts: number;
  routeExecutions: number;
  providerSends: number;
  providerReceiptIds: string[];
  authoritativeReceiptRecorded: boolean;
  replies: string[];
}

export interface SelfLeaveObservation {
  status: string;
  ownerStillConsented: boolean;
  parentBRevoked: boolean;
  consent: ConsentSnapshot;
  reply: string;
}

export interface CoparentConsentScenarioPort {
  bindAllAdults(): Promise<BindingObservation>;
  readConsent(bindingId: string): Promise<ConsentSnapshot>;
  capabilityTurn(
    stage: "pre_consent" | "post_consent" | "post_leave",
    bindingId: string,
  ): Promise<TurnObservation>;
  attackJoin(
    bindingId: string,
    vector: JoinAttackVector,
  ): Promise<JoinAttackObservation>;
  consentParentB(bindingId: string): Promise<{
    status: string;
    consent: ConsentSnapshot;
    routeStages: string[];
  }>;
  probeMemoryIsolation(
    binding: BindingObservation,
  ): Promise<MemoryIsolationObservation>;
  deliverExactlyOnce(
    binding: BindingObservation,
  ): Promise<ExactlyOnceObservation>;
  selfLeaveParentB(bindingId: string): Promise<SelfLeaveObservation>;
  bindSingleOwner(): Promise<{
    binding: BindingObservation;
    turn: TurnObservation;
  }>;
}

export interface ScenarioLedgerEvent {
  sequence: number;
  phase: string;
  actor: ScenarioActor;
  channel: ScenarioChannel;
  action: string;
  outcome: string;
  details: Record<string, unknown>;
}

export interface ScenarioLedgerAssertion {
  pass: true;
  evidence: Record<string, unknown>;
}

export interface CoparentConsentScenarioLedger {
  schemaVersion: "coparent-consent-scenario/v1";
  fixture: {
    provider: "fake_blooio";
    actors: ["Parent A", "Parent B", "Child C"];
    containsRealUserData: false;
  };
  events: ScenarioLedgerEvent[];
  assertions: Record<string, ScenarioLedgerAssertion>;
  verdict: "PASS";
}

export class CoparentConsentScenarioError extends Error {
  constructor(invariant: string) {
    super(`co-parent consent scenario invariant failed: ${invariant}`);
    this.name = "CoparentConsentScenarioError";
  }
}

function requireInvariant(
  condition: boolean,
  invariant: string,
): asserts condition {
  if (!condition) throw new CoparentConsentScenarioError(invariant);
}

function textsContainToken(texts: readonly string[], token: string): boolean {
  return texts.some((text) => text.includes(token));
}

function safeStatusDetails(status: ConsentSnapshot): Record<string, unknown> {
  return {
    mode: status.mode,
    gate: status.gate,
    requiredPrincipalCount: status.requiredPrincipalCount,
    registeredParticipantCount: status.registeredParticipantCount,
    linkedParticipantCount: status.linkedParticipantCount,
    consentedParticipantCount: status.consentedParticipantCount,
    participants: status.participants,
  };
}

/**
 * Runs one fixed synthetic scenario and returns a stable JSON-serializable
 * ledger. The supplied tokens are checked but never copied into the ledger,
 * so evidence output cannot itself disclose connector handles.
 */
export async function runCoparentConsentScenario(
  port: CoparentConsentScenarioPort,
  forbiddenOutputTokens: readonly string[],
): Promise<CoparentConsentScenarioLedger> {
  const events: ScenarioLedgerEvent[] = [];
  const assertions: Record<string, ScenarioLedgerAssertion> = {};
  const outputTexts: string[] = [];

  const event = (
    phase: string,
    actor: ScenarioActor,
    channel: ScenarioChannel,
    action: string,
    outcome: string,
    details: Record<string, unknown> = {},
  ) => {
    events.push({
      sequence: events.length + 1,
      phase,
      actor,
      channel,
      action,
      outcome,
      details,
    });
  };
  const pass = (name: string, evidence: Record<string, unknown>) => {
    assertions[name] = { pass: true, evidence };
  };

  const binding = await port.bindAllAdults();
  requireInvariant(
    binding.status === "bound",
    "all_adults owner claim must bind",
  );
  requireInvariant(
    binding.conversationId.startsWith("group:"),
    "binding must own one group room",
  );
  requireInvariant(
    binding.consent.mode === "all_adults",
    "binding mode must be all_adults",
  );
  requireInvariant(
    binding.consent.requiredPrincipalCount === 2,
    "all_adults binding must require exactly two principals",
  );
  requireInvariant(
    binding.routeStages?.join(",") ===
      "parent_a_dm_claim_issue,group_claim_consume",
    "all_adults owner binding must traverse direct and group routes",
  );
  event("bind", "Parent A", "group", "bind_all_adults", binding.status, {
    bindingId: binding.bindingId,
    conversationId: binding.conversationId,
    routeStages: binding.routeStages,
    ...safeStatusDetails(binding.consent),
  });
  pass("one_all_adults_binding", {
    bindingId: binding.bindingId,
    conversationId: binding.conversationId,
    routeStages: binding.routeStages,
  });

  const preConsent = await port.readConsent(binding.bindingId);
  requireInvariant(
    preConsent.gate === "restricted",
    "owner-only all_adults binding must restrict",
  );
  requireInvariant(
    preConsent.linkedParticipantCount === 1,
    "owner must be the sole linked principal",
  );
  requireInvariant(
    preConsent.consentedParticipantCount === 1,
    "owner binding must record one explicit owner consent",
  );
  const preTurn = await port.capabilityTurn("pre_consent", binding.bindingId);
  outputTexts.push(preTurn.reply);
  requireInvariant(
    !preTurn.capabilityExecuted,
    "pre-consent turn must not execute a capability",
  );
  requireInvariant(
    preTurn.mediaUrlCount === 1,
    "pre-consent turn must carry one synthetic media URL",
  );
  requireInvariant(
    !preTurn.mediaEnrichmentExecuted,
    "pre-consent media must not enter enrichment",
  );
  requireInvariant(
    !preTurn.runtimePrewarmExecuted,
    "pre-consent media must not prewarm the runtime",
  );
  requireInvariant(
    preTurn.roomId === binding.conversationId,
    "restricted turn must remain in group room",
  );
  event("pre_consent", "Parent A", "group", "capability_turn", preTurn.code, {
    capabilityExecuted: preTurn.capabilityExecuted,
    mediaUrlCount: preTurn.mediaUrlCount,
    mediaEnrichmentExecuted: preTurn.mediaEnrichmentExecuted,
    runtimePrewarmExecuted: preTurn.runtimePrewarmExecuted,
    roomId: preTurn.roomId,
    consent: safeStatusDetails(preConsent),
    reply: preTurn.reply,
  });
  pass("pre_consent_restricted", {
    code: preTurn.code,
    mediaUrlCount: 1,
    mediaEnrichmentExecuted: false,
    runtimePrewarmExecuted: false,
    capabilityExecuted: false,
  });

  const attackVectors: JoinAttackVector[] = [
    "forged",
    "expired",
    "replayed",
    "wrong_sender",
    "wrong_binding",
    "cross_thread",
  ];
  for (const vector of attackVectors) {
    const observed = await port.attackJoin(binding.bindingId, vector);
    requireInvariant(
      observed.vector === vector,
      `${vector} observation must retain its vector`,
    );
    requireInvariant(!observed.accepted, `${vector} join must fail closed`);
    if (vector === "cross_thread") {
      requireInvariant(
        observed.routeStages?.join(",") ===
          "group_join_issue,parent_b_dm_authenticate",
        "cross-thread probe must issue and authenticate through the route",
      );
      requireInvariant(
        observed.scopeRejectionSeam === "repository",
        "Blooio cross-thread mismatch must be injected at the repository seam",
      );
    }
    event(
      "join_adversarial",
      "Child C",
      "repository",
      vector,
      observed.status,
      {
        accepted: false,
        ...(observed.routeStages ? { routeStages: observed.routeStages } : {}),
        ...(observed.scopeRejectionSeam
          ? { scopeRejectionSeam: observed.scopeRejectionSeam }
          : {}),
      },
    );
  }
  pass("adversarial_joins_fail_closed", { vectors: attackVectors });

  const joined = await port.consentParentB(binding.bindingId);
  requireInvariant(
    joined.status === "consented",
    "Parent B join must end in explicit consent",
  );
  requireInvariant(
    joined.routeStages.join(",") ===
      "group_join_issue,parent_b_dm_authenticate,group_join_confirm",
    "Parent B join handshake must traverse the real route at every stage",
  );
  requireInvariant(
    joined.consent.gate === "enabled",
    "two consents must activate all_adults",
  );
  requireInvariant(
    joined.consent.linkedParticipantCount === 2,
    "two principals must be linked",
  );
  requireInvariant(
    joined.consent.consentedParticipantCount === 2,
    "two principals must consent",
  );
  requireInvariant(
    joined.consent.registeredParticipantCount === 3,
    "the unlinked Child C speaker must remain diagnostic, not a principal",
  );
  requireInvariant(
    new Set(joined.consent.linkedPrincipalIds).size === 2,
    "linked principals must be distinct accounts",
  );
  requireInvariant(
    new Set(joined.consent.consentProvenances).size === 2 &&
      joined.consent.consentProvenances.includes("owner_binding") &&
      joined.consent.consentProvenances.includes("authenticated_dm"),
    "both principals must have explicit, distinct consent provenance",
  );
  event(
    "consent",
    "Parent B",
    "group",
    "authenticated_join_confirm",
    joined.status,
    {
      ...safeStatusDetails(joined.consent),
      distinctLinkedPrincipals: 2,
      consentProvenances: ["owner_binding", "authenticated_dm"],
      childSpeakerLinkedAsPrincipal: false,
      routeStages: joined.routeStages,
    },
  );
  pass("two_distinct_linked_principals", {
    linkedParticipantCount: 2,
    consentedParticipantCount: 2,
    consentProvenances: ["owner_binding", "authenticated_dm"],
    routeStages: joined.routeStages,
  });
  pass("child_speaker_not_consent_principal", {
    registeredParticipantCount: 3,
    linkedParticipantCount: 2,
    gate: "enabled",
  });

  const postTurn = await port.capabilityTurn("post_consent", binding.bindingId);
  outputTexts.push(postTurn.reply);
  requireInvariant(
    postTurn.capabilityExecuted,
    "post-consent turn must execute a capability",
  );
  requireInvariant(
    postTurn.roomId === binding.conversationId,
    "active turn must use the shared room",
  );
  event("post_consent", "Parent B", "group", "capability_turn", postTurn.code, {
    capabilityExecuted: true,
    roomId: postTurn.roomId,
    reply: postTurn.reply,
  });
  pass("post_consent_activation", {
    code: postTurn.code,
    capabilityExecuted: true,
  });

  const memory = await port.probeMemoryIsolation(binding);
  const rooms = [
    memory.groupRoomId,
    memory.parentADmRoomId,
    memory.parentBDmRoomId,
  ];
  requireInvariant(
    new Set(rooms).size === 3,
    "group and private DM rooms must be distinct",
  );
  requireInvariant(
    memory.groupRoomId === binding.conversationId,
    "memory group room must match binding",
  );
  requireInvariant(
    textsContainToken(memory.groupRecall, memory.expectedGroupMarker),
    "group recall must contain the shared marker",
  );
  requireInvariant(
    !textsContainToken(memory.groupRecall, memory.expectedParentAMarker) &&
      !textsContainToken(memory.groupRecall, memory.expectedParentBMarker),
    "private markers must not enter group recall",
  );
  requireInvariant(
    textsContainToken(memory.parentADmRecall, memory.expectedParentAMarker) &&
      !textsContainToken(memory.parentADmRecall, memory.expectedGroupMarker) &&
      !textsContainToken(memory.parentADmRecall, memory.expectedParentBMarker),
    "Parent A DM recall must remain private",
  );
  requireInvariant(
    textsContainToken(memory.parentBDmRecall, memory.expectedParentBMarker) &&
      !textsContainToken(memory.parentBDmRecall, memory.expectedGroupMarker) &&
      !textsContainToken(memory.parentBDmRecall, memory.expectedParentAMarker),
    "Parent B DM recall must remain private",
  );
  event(
    "memory",
    "system",
    "repository",
    "bidirectional_recall_probe",
    "isolated",
    {
      groupRoomId: memory.groupRoomId,
      parentADmRoomId: memory.parentADmRoomId,
      parentBDmRoomId: memory.parentBDmRoomId,
      groupRecallCount: memory.groupRecall.length,
      parentADmRecallCount: memory.parentADmRecall.length,
      parentBDmRecallCount: memory.parentBDmRecall.length,
    },
  );
  pass("three_compartments_isolated_bidirectionally", {
    distinctRooms: 3,
    groupRecallCount: memory.groupRecall.length,
    parentADmRecallCount: memory.parentADmRecall.length,
    parentBDmRecallCount: memory.parentBDmRecall.length,
  });

  const exactlyOnce = await port.deliverExactlyOnce(binding);
  outputTexts.push(...exactlyOnce.replies);
  requireInvariant(
    exactlyOnce.inboundAttempts === 2,
    "scenario must replay the inbound webhook once",
  );
  requireInvariant(
    exactlyOnce.routeExecutions === 1,
    "gateway must route a replay exactly once",
  );
  requireInvariant(
    exactlyOnce.providerSends === 1,
    "provider reply must send exactly once",
  );
  requireInvariant(
    exactlyOnce.providerReceiptIds.length === 1,
    "provider must return one authoritative receipt",
  );
  requireInvariant(
    exactlyOnce.authoritativeReceiptRecorded,
    "authoritative provider receipt must be persisted",
  );
  event(
    "delivery",
    "Eliza",
    "group",
    "inbound_replay_and_reply",
    "exactly_once",
    {
      inboundAttempts: exactlyOnce.inboundAttempts,
      routeExecutions: exactlyOnce.routeExecutions,
      providerSends: exactlyOnce.providerSends,
      providerReceiptCount: exactlyOnce.providerReceiptIds.length,
      authoritativeReceiptRecorded: true,
      replies: exactlyOnce.replies,
    },
  );
  pass("exactly_once_with_authoritative_receipt", {
    inboundAttempts: 2,
    routeExecutions: 1,
    providerSends: 1,
    receiptCount: 1,
  });

  const left = await port.selfLeaveParentB(binding.bindingId);
  outputTexts.push(left.reply);
  requireInvariant(
    left.parentBRevoked,
    "Parent B self-leave must revoke Parent B",
  );
  requireInvariant(
    left.ownerStillConsented,
    "Parent B self-leave must preserve owner consent",
  );
  requireInvariant(
    left.consent.gate === "restricted",
    "self-leave must restrict the next turn",
  );
  requireInvariant(
    left.consent.consentedParticipantCount === 1,
    "one consent must remain after leave",
  );
  event("revocation", "Parent B", "group", "self_leave", left.status, {
    ownerStillConsented: true,
    parentBRevoked: true,
    consent: safeStatusDetails(left.consent),
    reply: left.reply,
  });
  const postLeaveTurn = await port.capabilityTurn(
    "post_leave",
    binding.bindingId,
  );
  outputTexts.push(postLeaveTurn.reply);
  requireInvariant(
    !postLeaveTurn.capabilityExecuted,
    "first turn after Parent B leave must not execute a capability",
  );
  event(
    "revocation",
    "Parent A",
    "group",
    "next_capability_turn",
    postLeaveTurn.code,
    {
      capabilityExecuted: false,
      reply: postLeaveTurn.reply,
    },
  );
  pass("parent_b_self_leave_is_scoped_and_immediate", {
    ownerStillConsented: true,
    parentBRevoked: true,
    nextTurnCapabilityExecuted: false,
  });

  const singleOwner = await port.bindSingleOwner();
  requireInvariant(
    singleOwner.binding.consent.mode === "single_owner",
    "omitted consent mode must preserve single_owner",
  );
  requireInvariant(
    singleOwner.binding.consent.requiredPrincipalCount === 1 &&
      singleOwner.binding.consent.gate === "enabled",
    "single_owner must remain enabled with one principal",
  );
  requireInvariant(
    singleOwner.turn.capabilityExecuted,
    "unchanged single_owner path must execute a capability",
  );
  outputTexts.push(singleOwner.turn.reply);
  event(
    "regression",
    "Parent A",
    "group",
    "single_owner_capability_turn",
    singleOwner.turn.code,
    {
      mode: singleOwner.binding.consent.mode,
      gate: singleOwner.binding.consent.gate,
      capabilityExecuted: true,
      reply: singleOwner.turn.reply,
    },
  );
  pass("single_owner_unchanged", {
    mode: "single_owner",
    gate: "enabled",
    capabilityExecuted: true,
  });

  for (const token of forbiddenOutputTokens) {
    requireInvariant(
      !outputTexts.some((text) => text.includes(token)),
      "raw connector handles must not appear in any output",
    );
  }
  pass("no_raw_handles_in_outputs", { checkedOutputs: outputTexts.length });

  return {
    schemaVersion: "coparent-consent-scenario/v1",
    fixture: {
      provider: "fake_blooio",
      actors: ["Parent A", "Parent B", "Child C"],
      containsRealUserData: false,
    },
    events,
    assertions,
    verdict: "PASS",
  };
}
