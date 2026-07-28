/**
 * Production orchestration for conversational parenting guidance. It binds
 * the current message to an authenticated household principal and graph child,
 * obtains a separate structural safety classification, evaluates the reviewed
 * policy, and resolves exact-locale handoff resources without allowing model
 * parameters to grant access or authorize disclosure.
 */

import crypto from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  Service,
} from "@elizaos/core";
import { type Entity, SELF_ENTITY_ID } from "@elizaos/shared";
import { resolveAuthenticatedFamilyPrincipal } from "../family-communications/production-wiring.js";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  HOUSEHOLD_ACCESS_SCOPES,
  HouseholdCoordinationError,
  type HouseholdCoordinationService,
  type HouseholdRole,
  type HouseholdRoleBinding,
} from "../household/index.js";
import {
  type OwnerActiveTravel,
  type OwnerFactProvenanceSource,
  type OwnerFacts,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { evaluateParentingGuidance } from "./policy.js";
import {
  getParentingHandoffResourceResolver,
  type ParentingHandoffContact,
  type ParentingHandoffResourceResolution,
  type ParentingLocaleEvidence,
} from "./resources.js";
import {
  getParentingSafetyClassifier,
  type ParentingSafetyClassificationStatus,
} from "./safety-classifier.js";
import {
  PARENTING_AGE_BANDS,
  PARENTING_GUIDANCE_VERSION,
  PARENTING_TOPICS,
  type ParentingAgeBand,
  type ParentingGuidanceDecision,
  type ParentingGuidanceRequest,
  type ParentingRequesterRole,
  type ParentingTopic,
} from "./types.js";

export const PARENTING_GUIDANCE_SERVICE = "lifeops_parenting_guidance";
export const PARENTING_AGE_BAND_ATTRIBUTE =
  "lifeops.parenting.ageBand" as const;
export const PARENTING_RECORD_SCOPE_ATTRIBUTE =
  "lifeops.parenting.recordScope" as const;

const MAX_CONTEXT_LENGTH = 32_768;
const CONNECTOR_LOCALE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const TRUSTED_LOCALE_PROVENANCE = new Set<OwnerFactProvenanceSource>([
  "first_run",
  "profile_save",
  "connector_inferred",
]);

export type ParentingGuidanceErrorCode =
  | "PARENTING_GUIDANCE_ACCESS_DENIED"
  | "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE"
  | "PARENTING_GUIDANCE_GRAPH_UNAVAILABLE"
  | "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID";

export class ParentingGuidanceError extends ElizaError {
  override readonly name = "ParentingGuidanceError";

  constructor(
    message: string,
    code: ParentingGuidanceErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "PARENTING_GUIDANCE_GRAPH_UNAVAILABLE" ||
        code === "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID"
          ? "fatal"
          : "ephemeral",
    });
  }
}

export interface ParentingGuidanceConversationInput {
  readonly message: Memory;
  readonly subjectEntityId?: string;
  readonly ageBand?: ParentingAgeBand;
  readonly topic: ParentingTopic;
  readonly requestedFramework?: "none" | "good_inside";
}

export interface ParentingGuidanceDelivery {
  readonly schemaVersion: typeof PARENTING_GUIDANCE_VERSION;
  readonly guidanceId: string;
  readonly subjectEntityId: string;
  readonly ageBand: ParentingAgeBand;
  readonly topic: ParentingTopic;
  readonly requestedFramework: "none" | "good_inside";
  readonly safetyClassificationStatus: ParentingSafetyClassificationStatus;
  readonly decision: ParentingGuidanceDecision;
  readonly localeEvidence: ParentingLocaleEvidence;
  readonly handoffResources: ParentingHandoffResourceResolution;
  readonly uncertaintyNotice: string;
  readonly humanNextStep: string;
  readonly externalEffectsPerformed: false;
}

export interface ParentingGuidanceServiceDependencies {
  readonly runtime: IAgentRuntime;
  readonly now?: () => Date;
  readonly resolveAuthenticatedPrincipal?: (
    runtime: IAgentRuntime,
    message: Memory,
  ) => Promise<string | null>;
  readonly resolveHousehold?: (
    runtime: IAgentRuntime,
  ) => HouseholdCoordinationService;
  readonly localeResolver?: ParentingLocaleResolver;
  readonly requestId?: () => string;
}

export interface ParentingLocaleResolver {
  resolve(input: {
    readonly runtime: IAgentRuntime;
    readonly requestedAt: string;
  }): Promise<ParentingLocaleEvidence>;
}

interface SubjectContext {
  readonly subjectEntityId: string;
  readonly ageBand: ParentingAgeBand;
  readonly requesterRole: ParentingRequesterRole;
  readonly grantedScopes: readonly string[];
  readonly recordScope: "household_shared" | "adult_private" | "teen_private";
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ParentingGuidanceError(
      `${field} is required`,
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ParentingGuidanceError(
      `${field} exceeds ${maximum} characters`,
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { field, maximum },
    );
  }
  return normalized;
}

function requesterRole(
  principalEntityId: string,
  binding: HouseholdRoleBinding | undefined,
  subjectEntityId: string,
): ParentingRequesterRole {
  if (principalEntityId === SELF_ENTITY_ID) return "owner";
  if (!binding) {
    throw new ParentingGuidanceError(
      "The authenticated principal has no household role",
      "PARENTING_GUIDANCE_ACCESS_DENIED",
      { principalEntityId },
    );
  }
  const roleMap: Readonly<Record<HouseholdRole, ParentingRequesterRole>> = {
    owner: "owner",
    co_parent: "co_parent",
    current_partner: "partner",
    caregiver: "caregiver",
    child: "subject_child",
    professional: "professional",
  };
  if (binding.role === "child" && principalEntityId !== subjectEntityId) {
    throw new ParentingGuidanceError(
      "A child principal may request guidance only for their own subject record",
      "PARENTING_GUIDANCE_ACCESS_DENIED",
      { principalEntityId, subjectEntityId },
    );
  }
  return roleMap[binding.role];
}

function trustedAttribute(entity: Entity, key: string): unknown | undefined {
  const attribute = entity.attributes?.[key];
  if (!attribute) return undefined;
  if (
    attribute.confidence !== 1 ||
    attribute.evidence.length === 0 ||
    !Number.isFinite(Date.parse(attribute.updatedAt))
  ) {
    throw new ParentingGuidanceError(
      `Entity ${entity.entityId} has untrusted ${key} metadata`,
      "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID",
      { entityId: entity.entityId, key },
    );
  }
  return attribute.value;
}

function ageBandFrom(
  entity: Entity,
  requested: ParentingAgeBand | undefined,
): ParentingAgeBand {
  const stored = trustedAttribute(entity, PARENTING_AGE_BAND_ATTRIBUTE);
  if (
    typeof stored === "string" &&
    PARENTING_AGE_BANDS.includes(stored as ParentingAgeBand)
  ) {
    return stored as ParentingAgeBand;
  }
  if (stored !== undefined) {
    throw new ParentingGuidanceError(
      `Entity ${entity.entityId} has an invalid parenting age band`,
      "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID",
      { entityId: entity.entityId },
    );
  }
  if (requested && PARENTING_AGE_BANDS.includes(requested)) return requested;
  throw new ParentingGuidanceError(
    "The child's developmental age band is needed before source-grounded guidance can be selected",
    "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
    { subjectEntityId: entity.entityId },
  );
}

function recordScopeFrom(
  entity: Entity,
): "household_shared" | "adult_private" | "teen_private" {
  const stored = trustedAttribute(entity, PARENTING_RECORD_SCOPE_ATTRIBUTE);
  if (stored === undefined) return "household_shared";
  if (
    stored === "household_shared" ||
    stored === "adult_private" ||
    stored === "teen_private"
  ) {
    return stored;
  }
  throw new ParentingGuidanceError(
    `Entity ${entity.entityId} has an invalid parenting record scope`,
    "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID",
    { entityId: entity.entityId },
  );
}

function candidateSubjectId(input: {
  requested?: string;
  principalEntityId: string;
  bindings: readonly HouseholdRoleBinding[];
}): string {
  if (input.requested !== undefined) {
    return requiredText(input.requested, "subjectEntityId", 200);
  }
  const childBindings = input.bindings.filter(
    (binding) => binding.role === "child",
  );
  const principalChild = childBindings.find(
    (binding) => binding.entityId === input.principalEntityId,
  );
  if (principalChild) return principalChild.entityId;
  const principalBinding = input.bindings.find(
    (binding) => binding.entityId === input.principalEntityId,
  );
  const accessibleChildIds =
    input.principalEntityId === SELF_ENTITY_ID
      ? childBindings.map((binding) => binding.entityId)
      : childBindings
          .filter((binding) =>
            principalBinding?.subjectEntityIds.includes(binding.entityId),
          )
          .map((binding) => binding.entityId);
  if (accessibleChildIds.length === 1 && accessibleChildIds[0]) {
    return accessibleChildIds[0];
  }
  throw new ParentingGuidanceError(
    accessibleChildIds.length === 0
      ? "No graph-backed child subject is available for this request"
      : "The request could refer to more than one child; select the intended child before guidance is generated",
    "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
    { candidateCount: accessibleChildIds.length },
  );
}

function validateTopic(topic: ParentingTopic): ParentingTopic {
  if (!PARENTING_TOPICS.includes(topic)) {
    throw new ParentingGuidanceError(
      "A supported parenting topic is required",
      "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
      { topic },
    );
  }
  return topic;
}

function validateFramework(
  framework: "none" | "good_inside" | undefined,
): "none" | "good_inside" {
  if (framework === undefined) return "none";
  if (framework === "none" || framework === "good_inside") return framework;
  throw new ParentingGuidanceError(
    "The requested parenting framework is unsupported",
    "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
    { framework },
  );
}

function trustedLocaleProvenance(
  value: OwnerFactProvenanceSource,
): value is "first_run" | "profile_save" | "connector_inferred" {
  return TRUSTED_LOCALE_PROVENANCE.has(value);
}

function activeTravelAt(
  travel: OwnerActiveTravel,
  requestedAt: number,
): boolean | null {
  const startsAt = Date.parse(travel.startIso);
  const endsAt = travel.endIso === undefined ? null : Date.parse(travel.endIso);
  if (
    !Number.isFinite(startsAt) ||
    (endsAt !== null && !Number.isFinite(endsAt))
  ) {
    return null;
  }
  return startsAt <= requestedAt && (endsAt === null || requestedAt <= endsAt);
}

function unavailableLocale(
  input: {
    locale: string | null;
    observedAt: string | null;
    provenance: "first_run" | "profile_save" | "connector_inferred" | null;
  },
  unavailableReason:
    | "locale_missing"
    | "locale_untrusted"
    | "locale_stale"
    | "locale_in_transit",
): ParentingLocaleEvidence {
  return {
    status: "unavailable",
    ...input,
    source: "unavailable",
    unavailableReason,
  };
}

/**
 * Uses only persisted locale facts with trusted provenance. Connector-derived
 * locales expire, and any active travel window suppresses a home locale
 * because a timezone cannot prove the jurisdiction needed for emergency
 * contacts.
 */
export class ConfiguredOwnerParentingLocaleResolver
  implements ParentingLocaleResolver
{
  async resolve(input: {
    readonly runtime: IAgentRuntime;
    readonly requestedAt: string;
  }): Promise<ParentingLocaleEvidence> {
    const requestedAt = Date.parse(input.requestedAt);
    if (!Number.isFinite(requestedAt)) {
      throw new ParentingGuidanceError(
        "requestedAt must be a valid ISO-8601 timestamp",
        "PARENTING_GUIDANCE_CONTEXT_INCOMPLETE",
        { requestedAt: input.requestedAt },
      );
    }
    const facts: OwnerFacts = await resolveOwnerFactStore(input.runtime).read();
    const locale = facts.locale;
    if (!locale) {
      return unavailableLocale(
        { locale: null, observedAt: null, provenance: null },
        "locale_missing",
      );
    }
    const provenance = trustedLocaleProvenance(locale.provenance.source)
      ? locale.provenance.source
      : null;
    const observedAt = Date.parse(locale.provenance.recordedAt);
    if (provenance === null || !Number.isFinite(observedAt)) {
      return unavailableLocale(
        {
          locale: locale.value,
          observedAt: locale.provenance.recordedAt,
          provenance,
        },
        "locale_untrusted",
      );
    }
    const activeTravel = facts.activeTravel
      ? activeTravelAt(facts.activeTravel.value, requestedAt)
      : false;
    if (activeTravel === null) {
      return unavailableLocale(
        {
          locale: locale.value,
          observedAt: locale.provenance.recordedAt,
          provenance,
        },
        "locale_untrusted",
      );
    }
    if (activeTravel) {
      return unavailableLocale(
        {
          locale: locale.value,
          observedAt: locale.provenance.recordedAt,
          provenance,
        },
        "locale_in_transit",
      );
    }
    if (
      observedAt > requestedAt ||
      (provenance === "connector_inferred" &&
        requestedAt - observedAt > CONNECTOR_LOCALE_MAX_AGE_MS)
    ) {
      return unavailableLocale(
        {
          locale: locale.value,
          observedAt: locale.provenance.recordedAt,
          provenance,
        },
        "locale_stale",
      );
    }
    return {
      status: "resolved",
      locale: locale.value,
      source: "configured_owner_locale",
      observedAt: locale.provenance.recordedAt,
      provenance,
      unavailableReason: null,
    };
  }
}

export const configuredOwnerParentingLocaleResolver =
  new ConfiguredOwnerParentingLocaleResolver();

const LOCALE_RESOLVER_KEY = Symbol.for(
  "@elizaos/plugin-personal-assistant:parenting-locale-resolver",
);

interface ParentingLocaleRuntime extends IAgentRuntime {
  [LOCALE_RESOLVER_KEY]?: ParentingLocaleResolver;
}

export function registerParentingLocaleResolver(
  runtime: IAgentRuntime,
  resolver: ParentingLocaleResolver,
): void {
  (runtime as ParentingLocaleRuntime)[LOCALE_RESOLVER_KEY] = resolver;
}

export function getParentingLocaleResolver(
  runtime: IAgentRuntime,
): ParentingLocaleResolver {
  return (
    (runtime as ParentingLocaleRuntime)[LOCALE_RESOLVER_KEY] ??
    configuredOwnerParentingLocaleResolver
  );
}

function guidanceUncertainty(
  decision: ParentingGuidanceDecision,
  resources: ParentingHandoffResourceResolution,
): string {
  if (decision.status === "educational_options") {
    return "These reviewed sources support general educational options, not a diagnosis, prediction about the child, or personalized clinical judgment.";
  }
  if (resources.status === "resolved") {
    return "The handoff records were reviewed for the configured locale, but service availability and local requirements can change; verify details on the linked official source.";
  }
  if (decision.handoff) {
    return "The assistant could not verify a complete, current contact set for the configured locale and will not guess a number or authority.";
  }
  return "The available structural evidence is not sufficient for ordinary guidance.";
}

function humanNextStep(decision: ParentingGuidanceDecision): string {
  switch (decision.status) {
    case "educational_options":
      return "Choose one small option to try, compare notes with another trusted caregiver, and contact the child's pediatrician or school support person if the concern persists or disrupts daily functioning.";
    case "evidence_unavailable":
      return "Try again after the reviewed source catalog is restored or ask a trusted pediatric or school professional for general educational resources; this is an evidence-maintenance stop, not a clinical judgment.";
    case "urgent_safety_handoff":
      return "Stay with the child if it is safe to do so and contact the resolved emergency or crisis service now; do not rely on this guidance as the safety response.";
    case "safeguarding_handoff":
      return "Contact the resolved child-safeguarding authority promptly, preserve factual observations, and do not investigate or confront an alleged person yourself.";
    case "professional_handoff":
      return "Contact the child's existing pediatrician, prescriber, or an appropriately licensed mental-health professional and share the factual timeline without changing medication on this assistant's advice.";
    case "legal_handoff":
      return "Take the exact order or parenting-plan text and factual timeline to a qualified family-law professional rather than treating this assistant's interpretation as authoritative.";
    case "privacy_withheld":
      return "Ask the child or an authorized caregiver to contact an appropriate trusted adult or professional without requesting disclosure of the private record here.";
    case "needs_safety_clarification":
      return "Clarify whether anyone may be in immediate danger and whether self-harm, harm to others, abuse, medication, severe symptoms, or a legal question is involved before using ordinary parenting options.";
  }
}

function contactText(contact: ParentingHandoffContact): string {
  if (contact.kind === "website") return `${contact.label}: ${contact.url}`;
  return `${contact.label}: ${contact.value}`;
}

export function renderParentingGuidanceDelivery(
  delivery: ParentingGuidanceDelivery,
): string {
  const lines: string[] = [];
  if (delivery.decision.status === "educational_options") {
    lines.push(
      "Here are source-grounded educational options, not a diagnosis or therapy:",
    );
    for (const option of delivery.decision.options) {
      lines.push(`- ${option.title}`);
      for (const step of option.steps) lines.push(`  - ${step}`);
      lines.push(`  - Sources: ${option.sourceIds.join(", ")}`);
    }
    lines.push("Sources:");
    for (const source of delivery.decision.sources) {
      lines.push(`- ${source.publisher}, “${source.title}”: ${source.url}`);
    }
  } else {
    lines.push("Ordinary parenting guidance stops at this boundary.");
    for (const reason of delivery.decision.reasons) lines.push(`- ${reason}`);
    if (delivery.decision.omissionNotice) {
      lines.push(delivery.decision.omissionNotice);
    }
  }
  if (delivery.decision.frameworkNotice) {
    lines.push(delivery.decision.frameworkNotice);
  }
  if (delivery.handoffResources.status === "resolved") {
    lines.push("Verified handoff resources for the configured locale:");
    for (const resource of delivery.handoffResources.resources) {
      lines.push(`- ${resource.title} (${resource.publisher})`);
      for (const contact of resource.contacts) {
        lines.push(`  - ${contactText(contact)}`);
      }
      lines.push(`  - Official source: ${resource.sourceUrl}`);
    }
  } else if (
    delivery.handoffResources.requestedKinds.length > 0 &&
    delivery.handoffResources.status === "unavailable"
  ) {
    lines.push(
      `Locale-specific contacts are unavailable (${delivery.handoffResources.unavailableReason}); no contact was guessed.`,
    );
  }
  lines.push(`Uncertainty: ${delivery.uncertaintyNotice}`);
  lines.push(`Human next step: ${delivery.humanNextStep}`);
  return lines.join("\n");
}

export class ParentingGuidanceService {
  private readonly now: () => Date;
  private readonly authenticate: NonNullable<
    ParentingGuidanceServiceDependencies["resolveAuthenticatedPrincipal"]
  >;
  private readonly resolveHousehold: NonNullable<
    ParentingGuidanceServiceDependencies["resolveHousehold"]
  >;
  private readonly requestId: () => string;

  constructor(private readonly deps: ParentingGuidanceServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.authenticate =
      deps.resolveAuthenticatedPrincipal ?? resolveAuthenticatedFamilyPrincipal;
    this.resolveHousehold =
      deps.resolveHousehold ??
      ((runtime) =>
        getHouseholdCoordinationService(runtime) ??
        createHouseholdCoordinationService(runtime));
    this.requestId =
      deps.requestId ?? (() => `parenting-guidance:${crypto.randomUUID()}`);
  }

  private async subjectContext(input: {
    principalEntityId: string;
    requestedSubjectEntityId?: string;
    requestedAgeBand?: ParentingAgeBand;
  }): Promise<SubjectContext> {
    const graph = resolveKnowledgeGraphService(this.deps.runtime);
    if (!graph) {
      throw new ParentingGuidanceError(
        "KnowledgeGraphService is required for parenting guidance",
        "PARENTING_GUIDANCE_GRAPH_UNAVAILABLE",
        { agentId: this.deps.runtime.agentId },
      );
    }
    const household = this.resolveHousehold(this.deps.runtime);
    const bindings = await household.listRoleBindings();
    const subjectEntityId = candidateSubjectId({
      requested: input.requestedSubjectEntityId,
      principalEntityId: input.principalEntityId,
      bindings,
    });
    const childBinding = bindings.find(
      (binding) =>
        binding.entityId === subjectEntityId && binding.role === "child",
    );
    if (!childBinding) {
      throw new ParentingGuidanceError(
        "The selected subject is not a graph-backed household child",
        "PARENTING_GUIDANCE_ACCESS_DENIED",
        { subjectEntityId },
      );
    }
    if (input.principalEntityId !== SELF_ENTITY_ID) {
      try {
        await household.requireScope({
          principalEntityId: input.principalEntityId,
          scope: "household.visibility",
          subjectEntityId,
        });
      } catch (error) {
        // error-policy:J2 parenting guidance exposes one stable access-denied
        // contract while retaining the household grant failure as its cause.
        if (
          error instanceof HouseholdCoordinationError &&
          (error.code === "HOUSEHOLD_ACCESS_DENIED" ||
            error.code === "HOUSEHOLD_GRANT_EXPIRED" ||
            error.code === "HOUSEHOLD_GRANT_REVOKED")
        ) {
          throw new ParentingGuidanceError(
            "The authenticated principal lacks an active household visibility grant for this child",
            "PARENTING_GUIDANCE_ACCESS_DENIED",
            {
              principalEntityId: input.principalEntityId,
              subjectEntityId,
            },
            error,
          );
        }
        throw error;
      }
    }
    const entity = await graph
      .getEntityStore(this.deps.runtime.agentId)
      .get(subjectEntityId);
    if (!entity) {
      throw new ParentingGuidanceError(
        "The selected child entity is unavailable",
        "PARENTING_GUIDANCE_PERSISTED_DATA_INVALID",
        { subjectEntityId },
      );
    }
    const exported = await household.exportFor({
      principalEntityId: input.principalEntityId,
    });
    const principalBinding = bindings.find(
      (binding) => binding.entityId === input.principalEntityId,
    );
    return {
      subjectEntityId,
      ageBand: ageBandFrom(entity, input.requestedAgeBand),
      requesterRole: requesterRole(
        input.principalEntityId,
        principalBinding,
        subjectEntityId,
      ),
      grantedScopes:
        input.principalEntityId === SELF_ENTITY_ID
          ? [...HOUSEHOLD_ACCESS_SCOPES]
          : exported.effectiveScopes,
      recordScope: recordScopeFrom(entity),
    };
  }

  async advise(
    input: ParentingGuidanceConversationInput,
  ): Promise<ParentingGuidanceDelivery> {
    const text = requiredText(
      input.message.content.text,
      "message.content.text",
      MAX_CONTEXT_LENGTH,
    );
    const topic = validateTopic(input.topic);
    const requestedFramework = validateFramework(input.requestedFramework);
    const principalEntityId = await this.authenticate(
      this.deps.runtime,
      input.message,
    );
    if (!principalEntityId) {
      throw new ParentingGuidanceError(
        "A verified runtime or household principal is required",
        "PARENTING_GUIDANCE_ACCESS_DENIED",
      );
    }
    const requestedAt = this.now().toISOString();
    // Subject authorization precedes model classification so an unauthorized
    // request never sends child-related prose to the model boundary.
    const subject = await this.subjectContext({
      principalEntityId,
      requestedSubjectEntityId: input.subjectEntityId,
      requestedAgeBand: input.ageBand,
    });
    const [classification, locale] = await Promise.all([
      getParentingSafetyClassifier(this.deps.runtime).classify({
        text,
        assessedAt: requestedAt,
      }),
      (
        this.deps.localeResolver ??
        getParentingLocaleResolver(this.deps.runtime)
      ).resolve({
        runtime: this.deps.runtime,
        requestedAt,
      }),
    ]);
    const requestId = input.message.id
      ? `parenting-guidance:${input.message.id}`
      : this.requestId();
    const request: ParentingGuidanceRequest = {
      schemaVersion: PARENTING_GUIDANCE_VERSION,
      requestId,
      requestedAt,
      subject: {
        entityId: subject.subjectEntityId,
        ageBand: subject.ageBand,
      },
      topic,
      requestedFramework,
      untrustedContextSummary: text,
      requester: {
        principalEntityId,
        role: subject.requesterRole,
        identityAssurance:
          principalEntityId === SELF_ENTITY_ID
            ? "runtime_owner"
            : "connector_verified",
        grantedScopes: subject.grantedScopes,
      },
      privacy: {
        recordScope: subject.recordScope,
        subjectEntityId: subject.subjectEntityId,
        subjectExplicitlyConsentedToRequester: false,
        // Only a separately registered qualified safeguarding policy may ever
        // widen this in a future revision. Planner/model parameters are not
        // accepted by this service.
        safetyDisclosureAuthorized: false,
      },
      safety: classification.assessment,
    };
    const decision = evaluateParentingGuidance(request);
    const handoffResources = await getParentingHandoffResourceResolver(
      this.deps.runtime,
    ).resolve({
      localeEvidence: locale,
      requestedAt,
      kinds: decision.handoff?.kinds ?? [],
    });
    return {
      schemaVersion: PARENTING_GUIDANCE_VERSION,
      guidanceId: requestId,
      subjectEntityId: subject.subjectEntityId,
      ageBand: subject.ageBand,
      topic,
      requestedFramework,
      safetyClassificationStatus: classification.status,
      decision,
      localeEvidence: locale,
      handoffResources,
      uncertaintyNotice: guidanceUncertainty(decision, handoffResources),
      humanNextStep: humanNextStep(decision),
      externalEffectsPerformed: false,
    };
  }
}

export class ParentingGuidanceRuntimeService extends Service {
  static override serviceType = PARENTING_GUIDANCE_SERVICE;

  override capabilityDescription =
    "Authenticated, source-grounded parenting education with structural safety/privacy gates and exact-locale human handoffs";

  readonly guidance: ParentingGuidanceService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new ParentingGuidanceError(
        "ParentingGuidanceRuntimeService requires a runtime",
        "PARENTING_GUIDANCE_GRAPH_UNAVAILABLE",
      );
    }
    this.guidance = new ParentingGuidanceService({ runtime });
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ParentingGuidanceRuntimeService> {
    return new ParentingGuidanceRuntimeService(runtime);
  }

  async stop(): Promise<void> {}

  advise(
    input: ParentingGuidanceConversationInput,
  ): Promise<ParentingGuidanceDelivery> {
    return this.guidance.advise(input);
  }
}

export function getParentingGuidanceService(
  runtime: IAgentRuntime,
): ParentingGuidanceRuntimeService | null {
  return runtime.getService<ParentingGuidanceRuntimeService>(
    PARENTING_GUIDANCE_SERVICE,
  );
}
