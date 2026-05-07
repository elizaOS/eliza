/**
 * LifeOps Service — thin facade that composes domain-specific mixins.
 *
 * The implementation lives in the `service-mixin-*.ts` files; standalone
 * helpers live in `service-normalize-*.ts` and `service-helpers-*.ts`.
 * This file only re-exports the public surface that consumers already import.
 */

export { LifeOpsServiceError } from "./service-types.js";

import { withBrowser } from "./service-mixin-browser.js";
import { withCalendar } from "./service-mixin-calendar.js";
import type { Constructor } from "./service-mixin-core.js";
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { withDefinitions } from "./service-mixin-definitions.js";
import { withDiscord } from "./service-mixin-discord.js";
import { withDrive } from "./service-mixin-drive.js";
import { withEmailUnsubscribe } from "./service-mixin-email-unsubscribe.js";
import { withGmail } from "./service-mixin-gmail.js";
import { withGoals } from "./service-mixin-goals.js";
import { withGoogle } from "./service-mixin-google.js";
import { withHealth } from "./service-mixin-health.js";
import { withIMessage } from "./service-mixin-imessage.js";
import { withInbox } from "./service-mixin-inbox.js";
import { withPayments } from "./service-mixin-payments.js";
import { withRelationships } from "./service-mixin-relationships.js";
import { withReminders } from "./service-mixin-reminders.js";
import { withScheduling } from "./service-mixin-scheduling.js";
import { withScreenTime } from "./service-mixin-screentime.js";
import { withSignal } from "./service-mixin-signal.js";
import { withSleep } from "./service-mixin-sleep.js";
import {
  type StatusMixinDependencies,
  withStatus,
} from "./service-mixin-status.js";
import { withSubscriptions } from "./service-mixin-subscriptions.js";
import { withTelegram } from "./service-mixin-telegram.js";
import { withTravel } from "./service-mixin-travel.js";
import { withWhatsApp } from "./service-mixin-whatsapp.js";
import { withWorkflows } from "./service-mixin-workflows.js";
import { withX } from "./service-mixin-x.js";
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
const LIFEOPS_WITH_PAYMENTS = withPayments(LIFEOPS_WITH_SCHEDULING);
const LIFEOPS_WITH_SUBS = withSubscriptions(LIFEOPS_WITH_PAYMENTS);
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
