/**
 * LifeOps Service — thin facade that composes domain-specific mixins.
 *
 * The implementation lives in the `service-mixin-*.ts` files; standalone
 * helpers live in `service-normalize-*.ts` and `service-helpers-*.ts`.
 * This file only re-exports the public surface that consumers already import.
 */

export { LifeOpsServiceError } from "./service-types.js";

import type {
  LifeOpsReminderAttempt,
  LifeOpsWorkflowRun,
} from "@elizaos/shared";
import type { BrowserBridgeService } from "./service-mixin-browser.js";
import { withBrowser } from "./service-mixin-browser.js";
// Public method interfaces each mixin contributes. The composed class type
// exceeds TypeScript's mixin-inference depth (~6 chained generics), so the
// `interface LifeOpsService` merge below restates them explicitly to surface
// every mixin method on the service type.
import type { LifeOpsCalendarService } from "./service-mixin-calendar.js";
import { withCalendar } from "./service-mixin-calendar.js";
import type { Constructor } from "./service-mixin-core.js";
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import type { LifeOpsDefinitionService } from "./service-mixin-definitions.js";
import { withDefinitions } from "./service-mixin-definitions.js";
import type { LifeOpsDiscordService } from "./service-mixin-discord.js";
import { withDiscord } from "./service-mixin-discord.js";
import type { LifeOpsDriveService } from "./service-mixin-drive.js";
import { withDrive } from "./service-mixin-drive.js";
import type { LifeOpsEmailUnsubscribeService } from "./service-mixin-email-unsubscribe.js";
import { withEmailUnsubscribe } from "./service-mixin-email-unsubscribe.js";
import type { LifeOpsGmailService } from "./service-mixin-gmail.js";
import { withGmail } from "./service-mixin-gmail.js";
import type { LifeOpsGoalService } from "./service-mixin-goals.js";
import { withGoals } from "./service-mixin-goals.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";
import { withGoogle } from "./service-mixin-google.js";
import type { LifeOpsHealthServicePublic } from "./service-mixin-health.js";
import { withHealth } from "./service-mixin-health.js";
import { withIMessage } from "./service-mixin-imessage.js";
import type { LifeOpsInboxService } from "./service-mixin-inbox.js";
import { withInbox } from "./service-mixin-inbox.js";
import { withRelationships } from "./service-mixin-relationships.js";
import type { LifeOpsReminderService } from "./service-mixin-reminders.js";
import { withReminders } from "./service-mixin-reminders.js";
import type { LifeOpsSchedulingService } from "./service-mixin-scheduling.js";
import { withScheduling } from "./service-mixin-scheduling.js";
import type { LifeOpsScreenTimeServicePublic } from "./service-mixin-screentime.js";
import { withScreenTime } from "./service-mixin-screentime.js";
import { withSignal } from "./service-mixin-signal.js";
import { withSleep } from "./service-mixin-sleep.js";
import type { LifeOpsStatusService } from "./service-mixin-status.js";
import {
  type StatusMixinDependencies,
  withStatus,
} from "./service-mixin-status.js";
import { withSubscriptions } from "./service-mixin-subscriptions.js";
import { withTelegram } from "./service-mixin-telegram.js";
import type { LifeOpsTravelServicePublic } from "./service-mixin-travel.js";
import { withTravel } from "./service-mixin-travel.js";
import { withWhatsApp } from "./service-mixin-whatsapp.js";
import type { LifeOpsWorkflowService } from "./service-mixin-workflows.js";
import { withWorkflows } from "./service-mixin-workflows.js";
import type { LifeOpsXService } from "./service-mixin-x.js";
import { withX } from "./service-mixin-x.js";
import type { LifeOpsXReadService } from "./service-mixin-x-read.js";
import { withXRead } from "./service-mixin-x-read.js";

/**
 * Mixin order follows dependency direction: Google auth → data layers
 * (Calendar, Gmail, Drive) → business logic (Reminders, Browser, Workflows,
 * Definitions, Goals) → connectors (X, Telegram, Discord, Signal).
 */
const LIFEOPS_BASE = withGoogle(LifeOpsServiceBase);
const LIFEOPS_WITH_DATA = withDrive(withGmail(withCalendar(LIFEOPS_BASE)));
const LIFEOPS_WITH_BUSINESS = withGoals(
  withDefinitions(withWorkflows(withBrowser(withReminders(LIFEOPS_WITH_DATA)))),
);
const LIFEOPS_WITH_X = withX(LIFEOPS_WITH_BUSINESS);
const LIFEOPS_WITH_RELATIONS = withRelationships(LIFEOPS_WITH_X);
const LIFEOPS_WITH_DOMAIN = withEmailUnsubscribe(
  withHealth(LIFEOPS_WITH_RELATIONS),
);
const LIFEOPS_WITH_X_READ = withXRead(LIFEOPS_WITH_DOMAIN);
const LIFEOPS_WITH_CONNECTORS = withWhatsApp(
  withSignal(withDiscord(withTelegram(withIMessage(LIFEOPS_WITH_X_READ)))),
);
const LIFEOPS_WITH_TRAVEL = withTravel(LIFEOPS_WITH_CONNECTORS);
const LIFEOPS_WITH_SCHEDULING = withScheduling(LIFEOPS_WITH_TRAVEL);
// Payment-source / transaction / spending logic moved to
// @elizaos/plugin-finances (FinancesService). Subscription audit / cancellation
// also moved there (SubscriptionsService), which reaches Gmail + the browser
// bridge through runtime-service seams. LifeOpsService no longer implements
// either back-end; the OWNER_FINANCES handler + the /api/lifeops/money/* and
// /api/lifeops/subscriptions/* routes delegate to the finances services. The
// `withSubscriptions` mixin is a thin forwarding shim that keeps the service
// surface stable for those call sites.
const LIFEOPS_WITH_SUBS = withSubscriptions(LIFEOPS_WITH_SCHEDULING);
// TypeScript loses track of constraint satisfaction past ~6 chained generic
// mixins, so we cast explicitly. The runtime composition has every method
// `withStatus` depends on (getScheduleMergedState from withScheduling,
// getBrowserSettings/listBrowserCompanions from withBrowser,
// getXConnectorStatus from withX, getHealthConnectorStatus from withHealth).
type LifeOpsSubsCtor = typeof LIFEOPS_WITH_SUBS;
const LIFEOPS_WITH_STATUS = withStatus(
  LIFEOPS_WITH_SUBS as LifeOpsSubsCtor & Constructor<StatusMixinDependencies>,
);
const LIFEOPS_COMPOSED = withInbox(
  withSleep(withScreenTime(LIFEOPS_WITH_STATUS)),
);

class LifeOpsServiceComposed extends LIFEOPS_COMPOSED {}

/**
 * Main LifeOps service — assembled from domain mixins layered on top of
 * {@link LifeOpsServiceBase}.
 */
export class LifeOpsService extends LifeOpsServiceComposed {}

/** Declared explicitly: mixin composition exceeds TypeScript inference depth. */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to surface mixin methods past TS inference depth
export interface LifeOpsService
  extends BrowserBridgeService,
    LifeOpsCalendarService,
    // `getHealthConnectorStatus` is also declared (with a different return
    // type) by the status mixin already on the composed class, so omit it here.
    Omit<LifeOpsHealthServicePublic, "getHealthConnectorStatus">,
    LifeOpsDefinitionService,
    LifeOpsDiscordService,
    LifeOpsDriveService,
    LifeOpsEmailUnsubscribeService,
    LifeOpsGmailService,
    LifeOpsGoalService,
    LifeOpsGoogleService,
    LifeOpsInboxService,
    LifeOpsReminderService,
    LifeOpsSchedulingService,
    LifeOpsScreenTimeServicePublic,
    LifeOpsStatusService,
    LifeOpsTravelServicePublic,
    LifeOpsWorkflowService,
    LifeOpsXReadService,
    // `getXConnectorStatus` is also surfaced (with a slightly different
    // signature) by the status mixin already on the composed class, so omit it
    // here to avoid an extends conflict while keeping the other X methods.
    Omit<LifeOpsXService, "getXConnectorStatus"> {
  processScheduledWork(request?: {
    now?: string;
    reminderLimit?: number;
    workflowLimit?: number;
    scheduledTaskLimit?: number;
  }): Promise<{
    now: string;
    reminderAttempts: LifeOpsReminderAttempt[];
    workflowRuns: LifeOpsWorkflowRun[];
    scheduledTaskFires: Array<Record<string, unknown>>;
    scheduledTaskCompletionTimeouts: Array<Record<string, unknown>>;
  }>;
}
