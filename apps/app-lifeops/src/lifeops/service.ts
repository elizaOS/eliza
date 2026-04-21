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
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { withDefinitions } from "./service-mixin-definitions.js";
import { withDiscord } from "./service-mixin-discord.js";
import { withDossier } from "./service-mixin-dossier.js";
import { withDrive } from "./service-mixin-drive.js";
import { withEmailUnsubscribe } from "./service-mixin-email-unsubscribe.js";
import { withGmail } from "./service-mixin-gmail.js";
import { withGoals } from "./service-mixin-goals.js";
import { withGoogle } from "./service-mixin-google.js";
import { withHealth } from "./service-mixin-health.js";
import { withIMessage } from "./service-mixin-imessage.js";
import { withRelationships } from "./service-mixin-relationships.js";
import { withReminders } from "./service-mixin-reminders.js";
import { withScheduling } from "./service-mixin-scheduling.js";
import { withScreenTime } from "./service-mixin-screentime.js";
import { withSignal } from "./service-mixin-signal.js";
import { withStatus } from "./service-mixin-status.js";
import { withSubscriptions } from "./service-mixin-subscriptions.js";
import { withTelegram } from "./service-mixin-telegram.js";
import { withTravel } from "./service-mixin-travel.js";
import { withUnifiedInbox } from "./service-mixin-unified-inbox.js";
import { withWhatsApp } from "./service-mixin-whatsapp.js";
import { withWorkflows } from "./service-mixin-workflows.js";
import { withX } from "./service-mixin-x.js";
import { withXRead } from "./service-mixin-x-read.js";

/**
 * Main LifeOps service — assembled from domain mixins layered on top of
 * {@link LifeOpsServiceBase}.
 *
 * Mixin order follows dependency direction: Google auth → data layers
 * (Calendar, Gmail, Drive) → business logic (Reminders, Browser, Workflows,
 * Definitions, Goals) → connectors (X, Telegram, Discord, Signal).
 */
export class LifeOpsServiceComposedBase extends withStatus(
  withUnifiedInbox(
    withHealth(
      withDossier(
        withScheduling(
          withScreenTime(
            withWhatsApp(
              withRelationships(
                withIMessage(
                  withSignal(
                    withDiscord(
                      withTelegram(
                        withXRead(
                          withX(
                            withGoals(
                              withDefinitions(
                                withWorkflows(
                                  withSubscriptions(
                                    withEmailUnsubscribe(
                                      withBrowser(
                                        withReminders(
                                          withGmail(
                                            withDrive(
                                              withTravel(
                                                withCalendar(
                                                  withGoogle(
                                                    LifeOpsServiceBase,
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
) {}

export class LifeOpsService extends LifeOpsServiceComposedBase {}
