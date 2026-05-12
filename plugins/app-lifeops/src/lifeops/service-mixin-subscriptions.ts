import type {
  BrowserBridgeAction,
  BrowserBridgeCompanionStatus,
} from "@elizaos/plugin-browser";
import type {
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
} from "@elizaos/shared";
import {
  createLifeOpsSubscriptionAudit,
  createLifeOpsSubscriptionCancellation,
  createLifeOpsSubscriptionCandidate,
} from "./repository.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  findLifeOpsSubscriptionPlaybook,
  type LifeOpsSubscriptionPlaybook,
  listLifeOpsSubscriptionPlaybooks,
  PLAYBOOK_NOT_IMPLEMENTED_ERROR,
  type SubscriptionAutomationStep,
} from "./subscriptions-playbooks.js";
import type {
  LifeOpsSubscriptionAudit,
  LifeOpsSubscriptionAuditSummary,
  LifeOpsSubscriptionCancellation,
  LifeOpsSubscriptionCancellationRequest,
  LifeOpsSubscriptionCancellationSummary,
  LifeOpsSubscriptionCandidate,
  LifeOpsSubscriptionDiscoveryRequest,
  LifeOpsSubscriptionExecutor,
} from "./subscriptions-types.js";

type BrowserArtifact = {
  kind: "screenshot" | "page_probe";
  label: string;
  detail: string;
};

type BrowserActionParams =
  | { action: "open" | "navigate"; url: string }
  | { action: "wait"; text?: string; selector?: string; timeout?: number }
  | { action: "click"; text?: string; selector?: string }
  | { action: "get_dom" | "screenshot" };

type BrowserActionResult = {
  success?: boolean;
  message?: string | null;
  content?: unknown;
  url?: string | null;
  title?: string | null;
  error?: string | null;
  data?: unknown;
  screenshot?: string | null;
};

type ComputerUseBrowserService = {
  executeBrowserAction(
    params: BrowserActionParams,
  ): Promise<BrowserActionResult>;
};

function isComputerUseBrowserService(
  service: unknown,
): service is ComputerUseBrowserService {
  return (
    Boolean(service) &&
    typeof service === "object" &&
    typeof (service as { executeBrowserAction?: unknown })
      .executeBrowserAction === "function"
  );
}

type BrowserSignalProbe = {
  status:
    | "clear"
    | "completed"
    | "needs_login"
    | "needs_mfa"
    | "phone_only"
    | "chat_only";
  detail: string | null;
};

type SubscriptionDependencies = LifeOpsServiceBase & {
  getGmailTriage(
    requestUrl: URL,
    request?: Record<string, unknown>,
    now?: Date,
  ): Promise<LifeOpsGmailTriageFeed>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
};

const MAX_AUDIT_MESSAGES = 80;
const DEFAULT_AUDIT_WINDOW_DAYS = 180;

function normalizeSubscriptionLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifySubscriptionValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function guessCadence(
  message: Pick<LifeOpsGmailMessageSummary, "subject" | "snippet">,
): LifeOpsSubscriptionCandidate["cadence"] {
  const blob = `${message.subject} ${message.snippet}`.toLowerCase();
  if (/\bannual\b|\byearly\b|\byear\b|\b12 month\b|\b12-month\b/.test(blob)) {
    return "annual";
  }
  if (
    /\bmonth\b|\bmonthly\b|\brenewal\b|\bsubscription\b|\bbilling\b/.test(blob)
  ) {
    return "monthly";
  }
  return "unknown";
}

function guessState(
  message: Pick<LifeOpsGmailMessageSummary, "subject" | "snippet">,
): LifeOpsSubscriptionCandidate["state"] {
  const blob = `${message.subject} ${message.snippet}`.toLowerCase();
  if (
    /\bcancelled\b|\bcanceled\b|\bended\b|\bexpires on\b|\bexpired\b/.test(blob)
  ) {
    return "canceled";
  }
  if (/\brenewal\b|\breceipt\b|\bbilled\b|\bpayment\b/.test(blob)) {
    return "active";
  }
  return "uncertain";
}

function parseUsdAmount(
  message: Pick<LifeOpsGmailMessageSummary, "subject" | "snippet">,
): number | null {
  const blob = `${message.subject} ${message.snippet}`;
  const match = blob.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function annualizeAmount(
  amount: number | null,
  cadence: LifeOpsSubscriptionCandidate["cadence"],
): number | null {
  if (amount === null) {
    return null;
  }
  if (cadence === "monthly") {
    return Number((amount * 12).toFixed(2));
  }
  if (cadence === "annual") {
    return Number(amount.toFixed(2));
  }
  return null;
}

function summarizeEvidence(
  serviceName: string,
  evidence: LifeOpsGmailMessageSummary[],
): string {
  const latest = evidence[0];
  if (!latest) {
    return `No recent email evidence found for ${serviceName}.`;
  }
  return `${serviceName}: ${evidence.length} matching email${evidence.length === 1 ? "" : "s"}, latest "${latest.subject}" on ${latest.receivedAt}.`;
}

function messageBlob(message: LifeOpsGmailMessageSummary): string {
  return [
    message.subject,
    message.snippet,
    message.from,
    message.fromEmail ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function scoreMessageAgainstPlaybook(
  message: LifeOpsGmailMessageSummary,
  playbook: LifeOpsSubscriptionPlaybook,
): number {
  const blob = messageBlob(message);
  let score = 0;
  for (const alias of [playbook.serviceName, ...playbook.aliases]) {
    if (blob.includes(alias.toLowerCase())) {
      score += 2;
    }
  }
  for (const keyword of playbook.auditSubjectKeywords) {
    if (blob.includes(keyword.toLowerCase())) {
      score += 1;
    }
  }
  for (const domain of playbook.auditDomains) {
    if (blob.includes(domain.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

function resolvePlaybookFromMessage(
  text: string,
): LifeOpsSubscriptionPlaybook | null {
  return findLifeOpsSubscriptionPlaybook(text);
}

function resolvePlaybookFromCandidate(
  candidate: Pick<LifeOpsSubscriptionCandidate, "serviceSlug" | "serviceName">,
): LifeOpsSubscriptionPlaybook | null {
  return (
    findLifeOpsSubscriptionPlaybook(candidate.serviceSlug) ??
    findLifeOpsSubscriptionPlaybook(candidate.serviceName)
  );
}

function toUserBrowserActions(
  playbook: LifeOpsSubscriptionPlaybook,
): CreateLifeOpsBrowserSessionRequest["actions"] {
  const actions: Array<Omit<BrowserBridgeAction, "id">> = [];
  for (const step of playbook.steps ?? []) {
    switch (step.kind) {
      case "open":
      case "navigate":
        actions.push({
          kind: step.kind,
          label: `${playbook.serviceName}: ${step.kind}`,
          url: step.url,
          selector: null,
          text: null,
          accountAffecting: false,
          requiresConfirmation: false,
          metadata: { playbookKey: playbook.key },
        });
        break;
      case "click_text":
        actions.push({
          kind: "click",
          label: `${playbook.serviceName}: click ${step.text}`,
          url: null,
          selector: companionSelectorForClickTextStep(playbook, step),
          text: step.text,
          accountAffecting: true,
          requiresConfirmation: step.destructive ?? false,
          metadata: { playbookKey: playbook.key },
        });
        break;
      case "click_selector":
        actions.push({
          kind: "click",
          label: `${playbook.serviceName}: click selector`,
          url: null,
          selector: step.selector,
          text: null,
          accountAffecting: true,
          requiresConfirmation: step.destructive ?? false,
          metadata: { playbookKey: playbook.key },
        });
        break;
      case "wait_text":
      case "assert_text":
      case "wait_selector":
      case "screenshot":
        actions.push({
          kind: "read_page",
          label: `${playbook.serviceName}: inspect page`,
          url: null,
          selector: null,
          text: null,
          accountAffecting: false,
          requiresConfirmation: false,
          metadata: {
            playbookKey: playbook.key,
            expected:
              step.kind === "wait_selector"
                ? step.selector
                : "text" in step
                  ? step.text
                  : step.label,
          },
        });
        break;
    }
  }
  return actions;
}

function companionSelectorForClickTextStep(
  playbook: LifeOpsSubscriptionPlaybook,
  step: Extract<SubscriptionAutomationStep, { kind: "click_text" }>,
): string {
  const clickText = step.text.trim().toLowerCase();
  if (clickText === "cancel subscription") {
    const selector = playbook.companionSelectors?.cancel;
    if (selector) {
      return selector;
    }
  }
  if (clickText === "confirm cancellation") {
    const selector = playbook.companionSelectors?.confirm;
    if (selector) {
      return selector;
    }
  }
  fail(
    400,
    `${playbook.serviceName} companion playbook is missing a selector for "${step.text}"`,
  );
}

function browserResultText(result: BrowserActionResult): string {
  return [
    result.message ?? "",
    typeof result.content === "string" ? result.content : "",
    typeof result.url === "string" ? result.url : "",
    typeof result.title === "string" ? result.title : "",
    result.error ?? "",
    result.data ? JSON.stringify(result.data) : "",
  ]
    .join(" ")
    .toLowerCase();
}

function summarizeCancellationStatus(
  cancellation: LifeOpsSubscriptionCancellation,
): string {
  switch (cancellation.status) {
    case "completed":
      return `${cancellation.serviceName} cancellation completed.`;
    case "awaiting_confirmation":
      return `Cancellation for ${cancellation.serviceName} is ready for final confirmation.`;
    case "needs_login":
      return `${cancellation.serviceName} needs the user to sign in before cancellation can continue.`;
    case "needs_mfa":
      return `${cancellation.serviceName} needs multi-factor verification before cancellation can continue.`;
    case "phone_only":
      return `${cancellation.serviceName} can only be canceled by phone.`;
    case "chat_only":
      return `${cancellation.serviceName} can only be canceled through support chat.`;
    case "already_canceled":
      return `${cancellation.serviceName} already appears to be canceled.`;
    case "unsupported_surface":
      if (
        typeof cancellation.error === "string" &&
        cancellation.error.startsWith(PLAYBOOK_NOT_IMPLEMENTED_ERROR)
      ) {
        return (
          cancellation.evidenceSummary ??
          `I can open the ${cancellation.serviceName} cancel page for you, but I haven't learned the exact click-flow yet. Want me to open the page and you finish the cancel?`
        );
      }
      return `I don't have a cancellation surface for ${cancellation.serviceName} yet${cancellation.error ? `: ${cancellation.error}` : "."}`;
    case "failed":
      return `Cancellation for ${cancellation.serviceName} failed${cancellation.error ? `: ${cancellation.error}` : "."}`;
    default:
      return `${cancellation.serviceName} cancellation status: ${cancellation.status}.`;
  }
}

function extractEvidenceMessages(
  messages: LifeOpsGmailMessageSummary[],
): Array<Record<string, unknown>> {
  return messages.slice(0, 5).map((message) => ({
    messageId: message.id,
    subject: message.subject,
    from: message.from,
    receivedAt: message.receivedAt,
    snippet: message.snippet,
    htmlLink: message.htmlLink,
  }));
}

async function probeBrowserSignals(
  computerUse: ComputerUseBrowserService,
  playbook: LifeOpsSubscriptionPlaybook,
): Promise<BrowserSignalProbe> {
  const dom = await computerUse.executeBrowserAction({ action: "get_dom" });
  const blob = browserResultText(dom);
  for (const marker of playbook.cancellationMarkers) {
    if (blob.includes(marker.toLowerCase())) {
      return { status: "completed", detail: marker };
    }
  }
  for (const marker of playbook.phoneOnlyMarkers) {
    if (blob.includes(marker.toLowerCase())) {
      return { status: "phone_only", detail: marker };
    }
  }
  for (const marker of playbook.chatOnlyMarkers) {
    if (blob.includes(marker.toLowerCase())) {
      return { status: "chat_only", detail: marker };
    }
  }
  for (const marker of playbook.mfaMarkers) {
    if (blob.includes(marker.toLowerCase())) {
      return { status: "needs_mfa", detail: marker };
    }
  }
  for (const marker of playbook.loginMarkers) {
    if (blob.includes(marker.toLowerCase())) {
      return { status: "needs_login", detail: marker };
    }
  }
  return { status: "clear", detail: null };
}

async function executeBrowserStep(
  computerUse: ComputerUseBrowserService,
  step: SubscriptionAutomationStep,
): Promise<BrowserActionResult> {
  let params: BrowserActionParams;
  switch (step.kind) {
    case "open":
      params = { action: "open", url: step.url };
      break;
    case "navigate":
      params = { action: "navigate", url: step.url };
      break;
    case "wait_text":
      params = {
        action: "wait",
        text: step.text,
        timeout: step.timeoutMs,
      };
      break;
    case "wait_selector":
      params = {
        action: "wait",
        selector: step.selector,
        timeout: step.timeoutMs,
      };
      break;
    case "click_text":
      params = { action: "click", text: step.text };
      break;
    case "click_selector":
      params = { action: "click", selector: step.selector };
      break;
    case "assert_text":
      params = { action: "get_dom" };
      break;
    case "screenshot":
      params = { action: "screenshot" };
      break;
  }
  return computerUse.executeBrowserAction(params);
}

function findServiceInText(
  text: string,
): { serviceName: string; serviceSlug: string } | null {
  const playbook = resolvePlaybookFromMessage(text);
  if (!playbook) {
    return null;
  }
  return {
    serviceName: playbook.serviceName,
    serviceSlug: playbook.key,
  };
}

/** @internal */
export function withSubscriptions<
  TBase extends Constructor<SubscriptionDependencies>,
>(Base: TBase) {
  class LifeOpsSubscriptionsServiceMixin extends Base {
    async listSubscriptionPlaybooks(): Promise<LifeOpsSubscriptionPlaybook[]> {
      return [...listLifeOpsSubscriptionPlaybooks()];
    }

    /**
     * Best-effort merchant→playbook lookup used by the Payments dashboard to
     * deep-link from a recurring charge row to the cancellation flow. Returns
     * a *trimmed* playbook descriptor (no `steps`) so callers don't render
     * automation internals.
     */
    findSubscriptionPlaybookForMerchant(merchant: string): {
      key: string;
      serviceName: string;
      managementUrl: string;
      executorPreference: LifeOpsSubscriptionPlaybook["executorPreference"];
    } | null {
      const playbook = findLifeOpsSubscriptionPlaybook(merchant);
      if (!playbook) {
        return null;
      }
      return {
        key: playbook.key,
        serviceName: playbook.serviceName,
        managementUrl: playbook.managementUrl,
        executorPreference: playbook.executorPreference,
      };
    }

    async getLatestSubscriptionAudit(): Promise<LifeOpsSubscriptionAuditSummary | null> {
      const audit = await this.repository.getLatestSubscriptionAudit(
        this.agentId(),
      );
      if (!audit) {
        return null;
      }
      const candidates =
        await this.repository.listSubscriptionCandidatesForAudit(
          this.agentId(),
          audit.id,
        );
      return { audit, candidates };
    }

    async auditSubscriptions(
      requestUrl: URL,
      request: LifeOpsSubscriptionDiscoveryRequest = {},
    ): Promise<LifeOpsSubscriptionAuditSummary> {
      const queryWindowDays = Math.max(
        1,
        Math.min(
          365,
          Number.isFinite(request.queryWindowDays)
            ? Math.trunc(request.queryWindowDays as number)
            : DEFAULT_AUDIT_WINDOW_DAYS,
        ),
      );
      const serviceQuery =
        normalizeOptionalString(request.serviceQuery) ?? null;
      let messages: LifeOpsGmailMessageSummary[] = [];
      let source: LifeOpsSubscriptionAudit["source"] = "gmail";

      try {
        const triage = await this.getGmailTriage(requestUrl, {
          maxResults: MAX_AUDIT_MESSAGES,
        });
        const sinceMs = Date.now() - queryWindowDays * 86_400_000;
        messages = triage.messages.filter((message) => {
          const receivedMs = Date.parse(message.receivedAt);
          return !Number.isNaN(receivedMs) && receivedMs >= sinceMs;
        });
      } catch (error) {
        source = serviceQuery ? "manual" : "gmail";
        this.logLifeOpsWarn(
          "subscriptions_audit",
          `gmail discovery unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const playbooks = serviceQuery
        ? listLifeOpsSubscriptionPlaybooks().filter((playbook) => {
            const lookup = normalizeSubscriptionLookup(serviceQuery);
            return (
              normalizeSubscriptionLookup(playbook.serviceName) === lookup ||
              playbook.aliases.some(
                (alias) => normalizeSubscriptionLookup(alias) === lookup,
              ) ||
              normalizeSubscriptionLookup(playbook.key) === lookup
            );
          })
        : listLifeOpsSubscriptionPlaybooks();

      const candidates: LifeOpsSubscriptionCandidate[] = [];
      for (const playbook of playbooks) {
        const evidence = messages
          .map((message) => ({
            message,
            score: scoreMessageAgainstPlaybook(message, playbook),
          }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);
        if (evidence.length === 0 && source !== "manual") {
          continue;
        }
        const bestEvidence = evidence[0] ?? null;
        const bestMessage = bestEvidence?.message ?? null;
        const cadence = bestMessage ? guessCadence(bestMessage) : "unknown";
        const state = bestMessage ? guessState(bestMessage) : "uncertain";
        const amount = bestMessage ? parseUsdAmount(bestMessage) : null;
        const confidence = bestEvidence
          ? Math.min(0.98, 0.45 + bestEvidence.score * 0.12)
          : 0.4;
        const candidate = createLifeOpsSubscriptionCandidate({
          agentId: this.agentId(),
          auditId: "",
          serviceSlug: playbook.key,
          serviceName: playbook.serviceName,
          provider:
            bestMessage?.fromEmail ??
            bestMessage?.from ??
            playbook.auditDomains[0] ??
            playbook.serviceName,
          cadence,
          state,
          confidence,
          annualCostEstimateUsd: annualizeAmount(amount, cadence),
          managementUrl: playbook.managementUrl,
          latestEvidenceAt: bestMessage?.receivedAt ?? null,
          evidenceJson: extractEvidenceMessages(
            evidence.map((item) => item.message),
          ),
          metadata: {
            playbookKey: playbook.key,
            evidenceCount: evidence.length,
            source,
          },
        });
        candidates.push(candidate);
      }

      const audit = createLifeOpsSubscriptionAudit({
        agentId: this.agentId(),
        source,
        queryWindowDays,
        status: "completed",
        totalCandidates: candidates.length,
        activeCandidates: candidates.filter(
          (candidate) => candidate.state === "active",
        ).length,
        canceledCandidates: candidates.filter(
          (candidate) => candidate.state === "canceled",
        ).length,
        uncertainCandidates: candidates.filter(
          (candidate) => candidate.state === "uncertain",
        ).length,
        summary:
          candidates.length === 0
            ? source === "manual"
              ? "No matching subscription playbooks were found for the requested service."
              : "No subscription evidence was found in recent Gmail receipts."
            : `Found ${candidates.length} likely subscription${candidates.length === 1 ? "" : "s"} from recent LifeOps signals.`,
        metadata: {
          serviceQuery,
          scannedMessageCount: messages.length,
          playbookCount: playbooks.length,
        },
      });
      await this.repository.createSubscriptionAudit(audit);

      for (const candidate of candidates) {
        const persisted = {
          ...candidate,
          auditId: audit.id,
        };
        await this.repository.createSubscriptionCandidate(persisted);
      }

      const persistedCandidates =
        await this.repository.listSubscriptionCandidatesForAudit(
          this.agentId(),
          audit.id,
        );
      return { audit, candidates: persistedCandidates };
    }

    async getSubscriptionCancellationStatus(args: {
      cancellationId?: string | null;
      serviceName?: string | null;
      serviceSlug?: string | null;
    }): Promise<LifeOpsSubscriptionCancellationSummary | null> {
      const serviceSlug = normalizeOptionalString(args.serviceSlug);
      let cancellation =
        normalizeOptionalString(args.cancellationId) !== undefined
          ? await this.repository.getSubscriptionCancellation(
              this.agentId(),
              requireNonEmptyString(args.cancellationId, "cancellationId"),
            )
          : await this.repository.getLatestSubscriptionCancellation(
              this.agentId(),
              serviceSlug,
            );

      if (!cancellation && normalizeOptionalString(args.serviceName)) {
        const playbook = resolvePlaybookFromMessage(
          requireNonEmptyString(args.serviceName, "serviceName"),
        );
        cancellation = await this.repository.getLatestSubscriptionCancellation(
          this.agentId(),
          playbook?.key,
        );
      }

      if (!cancellation) {
        return null;
      }

      if (cancellation.browserSessionId) {
        const session = await this.repository.getBrowserSession(
          this.agentId(),
          cancellation.browserSessionId,
        );
        if (session) {
          const nextStatus =
            session.status === "done"
              ? "completed"
              : session.status === "failed"
                ? "failed"
                : session.status === "awaiting_confirmation"
                  ? "awaiting_confirmation"
                  : "running";
          if (nextStatus !== cancellation.status) {
            cancellation = {
              ...cancellation,
              status: nextStatus,
              evidenceSummary:
                cancellation.evidenceSummary ??
                `Agent Browser Bridge session ${session.status}.`,
              error:
                nextStatus === "failed"
                  ? JSON.stringify(session.result)
                  : cancellation.error,
              updatedAt: new Date().toISOString(),
              finishedAt:
                nextStatus === "completed" || nextStatus === "failed"
                  ? new Date().toISOString()
                  : cancellation.finishedAt,
            };
            await this.repository.updateSubscriptionCancellation(cancellation);
          }
        }
      }

      const candidate = cancellation.candidateId
        ? await this.repository.getSubscriptionCandidate(
            this.agentId(),
            cancellation.candidateId,
          )
        : null;
      return { cancellation, candidate };
    }

    async cancelSubscription(
      request: LifeOpsSubscriptionCancellationRequest,
    ): Promise<LifeOpsSubscriptionCancellationSummary> {
      const candidate = request.candidateId
        ? await this.repository.getSubscriptionCandidate(
            this.agentId(),
            request.candidateId,
          )
        : null;
      const requestedServiceName = normalizeOptionalString(request.serviceName);
      const requestedServiceSlug = normalizeOptionalString(request.serviceSlug);
      const playbook =
        (candidate ? resolvePlaybookFromCandidate(candidate) : null) ??
        (requestedServiceSlug
          ? resolvePlaybookFromMessage(requestedServiceSlug)
          : null) ??
        (requestedServiceName
          ? resolvePlaybookFromMessage(requestedServiceName)
          : null);

      if (!candidate && !playbook && !requestedServiceName) {
        fail(
          400,
          "cancelSubscription requires a known candidateId or recognizable serviceName/serviceSlug",
        );
      }

      const serviceName =
        candidate?.serviceName ??
        playbook?.serviceName ??
        requestedServiceName!;
      const serviceSlug =
        candidate?.serviceSlug ??
        playbook?.key ??
        requestedServiceSlug ??
        slugifySubscriptionValue(serviceName);

      const connectedCompanions = await this.listBrowserCompanions();
      const explicitExecutor = normalizeOptionalString(request.executor);
      const executor = (explicitExecutor ??
        (connectedCompanions.some(
          (companion) => companion.connectionState === "connected",
        )
          ? "user_browser"
          : (playbook?.executorPreference ??
            "agent_browser"))) as LifeOpsSubscriptionExecutor;

      const confirmed =
        normalizeOptionalBoolean(request.confirmed, "confirmed") ?? false;
      let cancellation = createLifeOpsSubscriptionCancellation({
        agentId: this.agentId(),
        auditId: candidate?.auditId ?? null,
        candidateId: candidate?.id ?? null,
        serviceSlug,
        serviceName,
        executor,
        status: "draft",
        confirmed,
        currentStep: null,
        browserSessionId: null,
        evidenceSummary: null,
        artifactCount: 0,
        managementUrl:
          candidate?.managementUrl ?? playbook?.managementUrl ?? null,
        error: null,
        metadata: {
          playbookKey: playbook?.key ?? null,
          candidateState: candidate?.state ?? null,
        },
        finishedAt: null,
      });
      await this.repository.createSubscriptionCancellation(cancellation);

      if (!playbook) {
        cancellation = {
          ...cancellation,
          status: "unsupported_surface",
          error: "No known cancellation playbook for this service.",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        await this.repository.updateSubscriptionCancellation(cancellation);
        return { cancellation, candidate };
      }

      if (!playbook.steps || playbook.steps.length === 0) {
        // We know where the management page lives, but we don't have a
        // real click-flow implemented. Do NOT pretend to cancel by
        // opening the URL and taking a screenshot — surface the truthful
        // "not yet implemented" state so the owner can finish it manually.
        cancellation = {
          ...cancellation,
          status: "unsupported_surface",
          error: `${PLAYBOOK_NOT_IMPLEMENTED_ERROR}:${playbook.key}`,
          evidenceSummary: `I can open the ${playbook.serviceName} cancel page for you, but I haven't learned the exact click-flow yet. Want me to open the page and you finish the cancel? Management URL: ${playbook.managementUrl}`,
          managementUrl: playbook.managementUrl,
          metadata: {
            ...cancellation.metadata,
            playbookNotImplemented: true,
            managementUrl: playbook.managementUrl,
          },
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        await this.repository.updateSubscriptionCancellation(cancellation);
        return { cancellation, candidate };
      }

      if (candidate?.state === "canceled") {
        cancellation = {
          ...cancellation,
          status: "already_canceled",
          evidenceSummary: summarizeEvidence(serviceName, []),
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        await this.repository.updateSubscriptionCancellation(cancellation);
        return { cancellation, candidate };
      }

      if (executor === "user_browser") {
        const companion = connectedCompanions.find(
          (entry) => entry.connectionState === "connected",
        );
        if (!companion) {
          cancellation = {
            ...cancellation,
            status: "blocked",
            error: "No connected Agent Browser Bridge companion is available.",
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }
        const session = await this.createBrowserSession({
          title: `Manage ${serviceName} subscription`,
          browser: companion.browser,
          companionId: companion.id,
          profileId: companion.profileId,
          actions: toUserBrowserActions(playbook),
        });
        cancellation = {
          ...cancellation,
          status:
            session.status === "awaiting_confirmation"
              ? "awaiting_confirmation"
              : "running",
          currentStep: "browser_session_created",
          browserSessionId: session.id,
          updatedAt: new Date().toISOString(),
          metadata: {
            ...cancellation.metadata,
            browserSessionStatus: session.status,
          },
        };
        await this.repository.updateSubscriptionCancellation(cancellation);
        return { cancellation, candidate };
      }

      const computerUseService = this.runtime.getService("computeruse");
      const computerUse = isComputerUseBrowserService(computerUseService)
        ? computerUseService
        : null;
      if (!computerUse) {
        cancellation = {
          ...cancellation,
          status: "failed",
          error: "Computer-use service is not available.",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        await this.repository.updateSubscriptionCancellation(cancellation);
        return { cancellation, candidate };
      }

      const artifacts: BrowserArtifact[] = [];
      cancellation = {
        ...cancellation,
        status: "running",
        currentStep: "starting_playbook",
        updatedAt: new Date().toISOString(),
      };
      await this.repository.updateSubscriptionCancellation(cancellation);

      for (const step of playbook.steps ?? []) {
        if ("destructive" in step && step.destructive && !confirmed) {
          cancellation = {
            ...cancellation,
            status: "awaiting_confirmation",
            currentStep:
              step.kind === "click_text"
                ? step.text
                : step.kind === "click_selector"
                  ? step.selector
                  : "destructive_step",
            evidenceSummary:
              cancellation.evidenceSummary ??
              `Ready to confirm ${serviceName} cancellation.`,
            artifactCount: artifacts.length,
            metadata: {
              ...cancellation.metadata,
              artifacts,
            },
            updatedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }

        const result = await executeBrowserStep(computerUse, step);
        if (!result.success) {
          cancellation = {
            ...cancellation,
            status: "failed",
            currentStep: step.kind,
            error: result.error ?? result.message ?? "browser step failed",
            artifactCount: artifacts.length,
            metadata: {
              ...cancellation.metadata,
              artifacts,
              lastBrowserResult: result,
            },
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }

        if (step.kind === "screenshot" && result.screenshot) {
          artifacts.push({
            kind: "screenshot",
            label: step.label,
            detail: `screenshot:${result.screenshot.length}`,
          });
        }

        const probe = await probeBrowserSignals(computerUse, playbook);
        if (probe.status === "needs_login") {
          cancellation = {
            ...cancellation,
            status: "needs_login",
            currentStep: step.kind,
            evidenceSummary: probe.detail,
            artifactCount: artifacts.length,
            metadata: {
              ...cancellation.metadata,
              artifacts,
            },
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }
        if (probe.status === "needs_mfa") {
          cancellation = {
            ...cancellation,
            status: "needs_mfa",
            currentStep: step.kind,
            evidenceSummary: probe.detail,
            artifactCount: artifacts.length,
            metadata: {
              ...cancellation.metadata,
              artifacts,
            },
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }
        if (probe.status === "phone_only" || probe.status === "chat_only") {
          cancellation = {
            ...cancellation,
            status: probe.status,
            currentStep: step.kind,
            evidenceSummary: probe.detail,
            artifactCount: artifacts.length,
            metadata: {
              ...cancellation.metadata,
              artifacts,
            },
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          await this.repository.updateSubscriptionCancellation(cancellation);
          return { cancellation, candidate };
        }
      }

      const finalProbe = await probeBrowserSignals(computerUse, playbook);
      cancellation = {
        ...cancellation,
        status: finalProbe.status === "completed" ? "completed" : "blocked",
        currentStep: "done",
        evidenceSummary:
          finalProbe.detail ??
          `${serviceName} flow finished in the local browser.`,
        artifactCount: artifacts.length,
        metadata: {
          ...cancellation.metadata,
          artifacts,
        },
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await this.repository.updateSubscriptionCancellation(cancellation);
      return { cancellation, candidate };
    }

    summarizeSubscriptionAudit(
      summary: LifeOpsSubscriptionAuditSummary,
    ): string {
      if (summary.candidates.length === 0) {
        return summary.audit.summary;
      }
      return [
        summary.audit.summary,
        ...summary.candidates.slice(0, 5).map((candidate) => {
          const annual =
            candidate.annualCostEstimateUsd === null
              ? ""
              : `, est $${candidate.annualCostEstimateUsd.toFixed(2)}/yr`;
          return `- ${candidate.serviceName} (${candidate.state}, ${candidate.cadence}${annual})`;
        }),
      ].join("\n");
    }

    summarizeSubscriptionCancellation(
      summary: LifeOpsSubscriptionCancellationSummary,
    ): string {
      const status = summarizeCancellationStatus(summary.cancellation);
      const lines = [status];
      if (
        summary.cancellation.evidenceSummary &&
        summary.cancellation.evidenceSummary !== status
      ) {
        lines.push(summary.cancellation.evidenceSummary);
      }
      if (summary.candidate) {
        lines.push(
          `Candidate confidence ${summary.candidate.confidence.toFixed(2)} from ${summary.candidate.provider}.`,
        );
      }
      return lines.join(" ");
    }

    resolveSubscriptionIntent(text: string): {
      mode: "audit" | "cancel" | "status" | null;
      serviceName?: string;
      serviceSlug?: string;
      executor?: LifeOpsSubscriptionExecutor;
    } {
      const normalized = text.trim().toLowerCase();
      if (!normalized) {
        return { mode: null };
      }
      const matchedService = findServiceInText(text);
      if (
        /\baudit\b|\breport\b|\breview\b|\bfind\b.*\bsubscription\b|\bwhat subscriptions\b/.test(
          normalized,
        )
      ) {
        return {
          mode: "audit",
          ...matchedService,
        };
      }
      if (
        /\bcancel\b|\bunsubscribe\b|\bend\b.*\bsubscription\b/.test(normalized)
      ) {
        return {
          mode: "cancel",
          ...matchedService,
          executor: /\bin my browser\b|\bpersonal browser\b/.test(normalized)
            ? "user_browser"
            : "agent_browser",
        };
      }
      if (
        /\bstatus\b|\bwhat happened\b|\bupdate\b.*\bsubscription\b/.test(
          normalized,
        )
      ) {
        return {
          mode: "status",
          ...matchedService,
        };
      }
      return { mode: null, ...matchedService };
    }
  }

  return LifeOpsSubscriptionsServiceMixin;
}
