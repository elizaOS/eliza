/**
 * Production composition for the school-calendar and monthly family-packet
 * workflows. It projects canonical calendar, school, agreement, household,
 * and owner-fact stores into provenance-bearing packet claims and owns only a
 * restart-safe aggregate run lease; scheduling and approvals remain external.
 */

import { createHash, randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
  CalendarService,
} from "@elizaos/plugin-calendar";
import { type LifeOpsCalendarEvent, SELF_ENTITY_ID } from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalRequest } from "../approval-queue.types.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import {
  type FamilyPacketClaim,
  type FamilyPacketPeriod,
  type MonthlyFamilyDraft,
  type MonthlyFamilyPacket,
  MonthlyFamilyPacketService,
} from "../family-coordination/index.js";
import {
  getAgreementKnowledgeService,
  HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE,
  type ParentingAgreementObligation,
} from "../household/agreement-knowledge.js";
import { HouseholdCoordinationRepository } from "../household/repository.js";
import { resolveOwnerFactStore } from "../owner/fact-store.js";
import {
  CONCORD_SCHOOL_CALENDAR_SOURCE,
  type SchoolCalendarRunResult,
  type SchoolCalendarSourceConfig,
  SchoolCalendarWorkflow,
  type SchoolCalendarWorkflowStatus,
} from "../school/calendar-workflow.js";
import {
  getSchoolSourceFactRuntimeService,
  SCHOOL_SOURCE_FACT_SERVICE,
} from "../school/service.js";
import type { SourceFact } from "../school/types.js";
import { executeRawSql, parseJsonValue, sqlQuote, toText } from "../sql.js";

export const FAMILY_WORKFLOW_RUNTIME_SERVICE = "lifeops_family_workflows";
export const FAMILY_MONTHLY_SYSTEM_OPERATION =
  "family.monthlyCoordination" as const;

const RUN_LEASE_MS = 10 * 60_000;
const RUN_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_workflow_runs (
    agent_id TEXT NOT NULL, period_key TEXT NOT NULL, run_id TEXT NOT NULL,
    state TEXT NOT NULL, trigger_kind TEXT NOT NULL, lease_token TEXT,
    lease_expires_at TEXT, result_json TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, period_key)
  )`,
] as const;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function periodFor(date: Date): FamilyPacketPeriod {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month)
    throw new Error("[FamilyWorkflowRuntime] period unavailable");
  const key = `${year}-${month}`;
  const next = new Date(Date.UTC(Number(year), Number(month), 1));
  return {
    key,
    startsOn: `${key}-01`,
    endsOnExclusive: next.toISOString().slice(0, 10),
    timeZone: "America/New_York",
  };
}

function calendarClaim(event: LifeOpsCalendarEvent): FamilyPacketClaim {
  return {
    claimId: `calendar:${event.provider}:${event.calendarId}:${event.externalId}`,
    stableKey: `calendar:${event.provider}:${event.calendarId}:${event.externalId}`,
    section: "custody_calendar",
    statement: event.title,
    visibility: "owner_only",
    provenance: [
      {
        source: "calendar",
        sourceId: event.id,
        observedAt: event.updatedAt,
        contentSha256: hash(event),
      },
    ],
    dates: [`${event.startAt} through ${event.endAt}`],
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
  };
}

function schoolClaim(fact: SourceFact): FamilyPacketClaim {
  return {
    claimId: `school:${fact.id}`,
    stableKey: fact.stableFactKey,
    section: "school",
    statement: JSON.stringify(fact.value),
    visibility:
      fact.visibility === "owner_private" ? "owner_only" : "guest_shareable",
    provenance: [
      {
        source: "school",
        sourceId: fact.artifactId,
        observedAt: fact.createdAt,
        contentSha256: fact.revisionSha256,
      },
    ],
    dates: [fact.effectiveFrom, fact.effectiveUntil].filter(
      (value): value is string => Boolean(value),
    ),
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
  };
}

function obligationClaim(
  value: ParentingAgreementObligation,
  recipientEntityIds: readonly string[],
): FamilyPacketClaim {
  return {
    claimId: `agreement:${value.id}`,
    stableKey: `agreement:${value.id}`,
    section: "approved_obligations",
    statement: value.obligationText,
    visibility: "guest_shareable",
    provenance: [
      {
        source: "agreement",
        sourceId: `${value.artifactId}:pages:${value.pageStart}-${value.pageEnd}`,
        observedAt: value.updatedAt,
        contentSha256: hash({
          text: value.obligationText,
          citation: value.citationText,
        }),
      },
    ],
    dates: [],
    requests: [],
    urgency: null,
    commitments: [value.title],
    accountability: [],
    obligationApprovalId: value.id,
    agreementArtifactId: value.artifactId,
    recipientEntityIds,
  };
}

export interface FamilyWorkflowRunResult {
  state: "completed" | "already_running" | "deduplicated";
  runId: string;
  periodKey: string;
  school: SchoolCalendarRunResult | null;
  packet: MonthlyFamilyPacket | null;
}

export interface FamilyWorkflowRuntimeDeps {
  now?: () => Date;
  schoolWorkflow?: SchoolCalendarWorkflow;
  collectClaims?: (period: FamilyPacketPeriod) => Promise<FamilyPacketClaim[]>;
}

export class FamilyWorkflowRuntimeService extends Service {
  static override serviceType = FAMILY_WORKFLOW_RUNTIME_SERVICE;
  override capabilityDescription =
    "Owner-authorized school-calendar ingestion and monthly family packet generation through canonical stores, scheduling, and approvals";

  readonly school: SchoolCalendarWorkflow;
  readonly packets: MonthlyFamilyPacketService;
  private readonly now: () => Date;
  private initialized = false;

  constructor(
    runtime?: IAgentRuntime,
    private readonly deps: FamilyWorkflowRuntimeDeps = {},
  ) {
    super(runtime);
    if (!runtime)
      throw new Error("[FamilyWorkflowRuntime] runtime is required");
    this.now = deps.now ?? (() => new Date());
    this.school = deps.schoolWorkflow ?? new SchoolCalendarWorkflow(runtime);
    this.packets = new MonthlyFamilyPacketService(runtime, this.now);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FamilyWorkflowRuntimeService> {
    await Promise.all([
      runtime.getServiceLoadPromise(CalendarService.serviceType),
      runtime.getServiceLoadPromise(SCHOOL_SOURCE_FACT_SERVICE),
      runtime.getServiceLoadPromise(HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE),
    ]);
    return new FamilyWorkflowRuntimeService(runtime);
  }

  async stop(): Promise<void> {}

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    for (const statement of RUN_SCHEMA)
      await executeRawSql(this.runtime, statement);
    this.initialized = true;
  }

  configureSchool(
    config: SchoolCalendarSourceConfig = CONCORD_SCHOOL_CALENDAR_SOURCE,
  ): Promise<SchoolCalendarWorkflowStatus> {
    return this.school.configure(config);
  }

  schoolStatus(): Promise<SchoolCalendarWorkflowStatus> {
    return this.school.status();
  }

  reviewSchool(runId: string) {
    return this.school.review(runId);
  }

  runSchool(
    trigger: "manual" | "scheduled" = "manual",
  ): Promise<SchoolCalendarRunResult> {
    return this.school.run(CONCORD_SCHOOL_CALENDAR_SOURCE, trigger);
  }

  async applySchool(runId: string, requestUrl: URL): Promise<void> {
    const gateway = this.runtime.getService(
      CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
    ) as
      | Parameters<SchoolCalendarWorkflow["applyApprovedPlan"]>[0]["gateway"]
      | null;
    if (!gateway)
      throw new Error(
        "[FamilyWorkflowRuntime] calendar mutation gateway unavailable",
      );
    await this.school.applyApprovedPlan({ runId, requestUrl, gateway });
  }

  async collectCanonicalClaims(
    period: FamilyPacketPeriod,
  ): Promise<FamilyPacketClaim[]> {
    if (this.deps.collectClaims) return this.deps.collectClaims(period);
    const claims: FamilyPacketClaim[] = [];
    const calendar = this.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (calendar) {
      const feed = await calendar.getCalendarFeed(
        new URL("http://localhost/api/lifeops/calendar/feed"),
        {
          timeMin: `${period.startsOn}T00:00:00.000-04:00`,
          timeMax: `${period.endsOnExclusive}T00:00:00.000-04:00`,
          timeZone: period.timeZone,
        },
      );
      claims.push(...feed.events.map(calendarClaim));
    }
    const school = getSchoolSourceFactRuntimeService(this.runtime);
    if (school) claims.push(...(await school.listFacts()).map(schoolClaim));
    const agreements = getAgreementKnowledgeService(this.runtime);
    if (agreements) {
      for (const obligation of await agreements.listApprovedObligations()) {
        claims.push(
          obligationClaim(
            obligation,
            await agreements.listActiveGuestPrincipals({
              artifactId: obligation.artifactId,
              ownerEntityId: SELF_ENTITY_ID,
            }),
          ),
        );
      }
    }
    const household = new HouseholdCoordinationRepository(
      this.runtime,
      this.runtime.agentId,
    );
    for (const agreement of await household.listAgreements()) {
      if (!agreement.isCurrent) continue;
      claims.push({
        claimId: `household:${agreement.id}`,
        stableKey: `household:${agreement.coordinationId}`,
        section: "custody_calendar",
        statement: agreement.terms.summary,
        visibility: "guest_shareable",
        provenance: [
          {
            source: "household",
            sourceId: agreement.id,
            observedAt: agreement.activatedAt,
            contentSha256: hash(agreement),
          },
        ],
        dates: [`${agreement.terms.startAt} through ${agreement.terms.endAt}`],
        requests: [],
        urgency: null,
        commitments: [],
        accountability: [],
        recipientEntityIds: agreement.approvedByEntityIds.filter(
          (entityId) => entityId !== SELF_ENTITY_ID,
        ),
      });
    }
    const travel = (await resolveOwnerFactStore(this.runtime).read())
      .activeTravel;
    if (travel) {
      claims.push({
        claimId: `owner-travel:${travel.provenance.recordedAt}`,
        stableKey: "owner:active-travel",
        section: "travel_consent_health",
        statement: "Owner travel window is active.",
        visibility: "owner_only",
        provenance: [
          {
            source: "knowledge",
            sourceId: "owner-fact:activeTravel",
            observedAt: travel.provenance.recordedAt,
            contentSha256: hash(travel.value),
          },
        ],
        dates: [travel.value.startIso, travel.value.endIso].filter(
          (value): value is string => Boolean(value),
        ),
        requests: [],
        urgency: null,
        commitments: [],
        accountability: [],
      });
    }
    return claims;
  }

  async generatePacket(
    period = periodFor(this.now()),
  ): Promise<MonthlyFamilyPacket> {
    return this.packets.buildInternal(
      period,
      await this.collectCanonicalClaims(period),
    );
  }

  async createDraft(
    packetId: string,
    input: {
      recipient: string;
      recipientEntityId: string;
      calendarPrivacyMode: "full" | "times_only" | "busy_only";
    },
  ): Promise<MonthlyFamilyDraft> {
    const packet = await this.packets.read(packetId);
    if (!packet) throw new Error("[FamilyWorkflowRuntime] packet not found");
    const entity = await resolveKnowledgeGraphService(this.runtime)
      ?.getEntityStore(this.runtime.agentId)
      .get(input.recipientEntityId);
    const recipient = input.recipient.trim();
    if (
      !entity?.identities.some(
        (identity) =>
          identity.verified &&
          ["imessage", "blooio", "sms", "phone"].includes(
            identity.platform.toLowerCase(),
          ) &&
          identity.handle === recipient,
      )
    ) {
      throw new Error(
        "[FamilyWorkflowRuntime] recipient is not a verified iMessage Entity identity",
      );
    }
    return this.packets.createExternalDraft(packet, {
      ...input,
      recipient,
    });
  }

  async requestDraftApproval(args: {
    packetId: string;
    draftVersion: number;
    requestedBy: string;
    subjectUserId: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
    const draft = await this.packets.readDraft(
      args.packetId,
      args.draftVersion,
    );
    if (!draft) throw new Error("[FamilyWorkflowRuntime] draft not found");
    return this.packets.enqueueDraftApproval({
      ...args,
      draft,
      queue: createApprovalQueue(this.runtime, {
        agentId: this.runtime.agentId,
      }),
    });
  }

  async runMonthly(
    trigger: "manual" | "scheduled",
  ): Promise<FamilyWorkflowRunResult> {
    await new CalendarCardAccessStore(this.runtime).cleanup();
    await this.ensureSchema();
    const period = periodFor(this.now());
    const token = randomUUID();
    const now = this.now();
    const expires = new Date(now.getTime() + RUN_LEASE_MS).toISOString();
    const runId = randomUUID();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_workflow_runs (agent_id,period_key,run_id,state,trigger_kind,lease_token,lease_expires_at,created_at,updated_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(period.key)},${sqlQuote(runId)},'running',${sqlQuote(trigger)},${sqlQuote(token)},${sqlQuote(expires)},${sqlQuote(now.toISOString())},${sqlQuote(now.toISOString())}) ON CONFLICT (agent_id,period_key) DO NOTHING`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_family_workflow_runs SET run_id=${sqlQuote(runId)},state='running',trigger_kind=${sqlQuote(trigger)},lease_token=${sqlQuote(token)},lease_expires_at=${sqlQuote(expires)},updated_at=${sqlQuote(now.toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND state <> 'completed' AND (lease_token IS NULL OR lease_expires_at < ${sqlQuote(now.toISOString())} OR lease_token=${sqlQuote(token)}) RETURNING run_id`,
    );
    if (rows.length === 0) {
      const existing = await executeRawSql(
        this.runtime,
        `SELECT run_id,state,result_json FROM app_lifeops.life_family_workflow_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} LIMIT 1`,
      );
      const row = existing[0];
      if (toText(row?.state) === "completed") {
        const result = parseJsonValue<FamilyWorkflowRunResult>(
          row?.result_json,
          null as never,
        );
        return { ...result, state: "deduplicated" };
      }
      return {
        state: "already_running",
        runId: toText(row?.run_id),
        periodKey: period.key,
        school: null,
        packet: null,
      };
    }
    try {
      const school = await this.runSchool(trigger);
      const packet = await this.generatePacket(period);
      const result: FamilyWorkflowRunResult = {
        state: "completed",
        runId,
        periodKey: period.key,
        school,
        packet,
      };
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_family_workflow_runs SET state='completed',lease_token=NULL,lease_expires_at=NULL,result_json=${sqlQuote(JSON.stringify(result))},updated_at=${sqlQuote(this.now().toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND lease_token=${sqlQuote(token)}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_family_workflow_runs SET state='failed',lease_token=NULL,lease_expires_at=NULL,error_message=${sqlQuote(message)},updated_at=${sqlQuote(this.now().toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND lease_token=${sqlQuote(token)}`,
      );
      throw error;
    }
  }
}

export function getFamilyWorkflowRuntimeService(
  runtime: IAgentRuntime,
): FamilyWorkflowRuntimeService | null {
  return runtime.getService<FamilyWorkflowRuntimeService>(
    FAMILY_WORKFLOW_RUNTIME_SERVICE,
  );
}
