/**
 * LifeOps Service — thin facade that composes domain-specific mixins.
 *
 * The implementation lives in the `service-mixin-*.ts` files; standalone
 * helpers live in `service-normalize-*.ts` and `service-helpers-*.ts`.
 * This file only re-exports the public surface that consumers already import.
 */

export { LifeOpsServiceError } from "./service-types.js";

import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { withGoogle } from "./service-mixin-google.js";
import { withCalendar } from "./service-mixin-calendar.js";
import { withGmail } from "./service-mixin-gmail.js";
import { withReminders } from "./service-mixin-reminders.js";
import { withBrowser } from "./service-mixin-browser.js";
import { withWorkflows } from "./service-mixin-workflows.js";
import { withDefinitions } from "./service-mixin-definitions.js";
import { withGoals } from "./service-mixin-goals.js";
import { withX } from "./service-mixin-x.js";
import { withTelegram } from "./service-mixin-telegram.js";
import { withDiscord } from "./service-mixin-discord.js";
import { withSignal } from "./service-mixin-signal.js";

/**
 * Main LifeOps service — assembled from domain mixins layered on top of
 * {@link LifeOpsServiceBase}.
 *
 * Mixin order follows dependency direction: Google auth → data layers
 * (Calendar, Gmail) → business logic (Reminders, Browser, Workflows,
 * Definitions, Goals) → connectors (X, Telegram, Discord, Signal).
 */
class LifeOpsServiceComposedBase extends withSignal(
  withDiscord(
    withTelegram(
      withX(
        withGoals(
          withDefinitions(
            withWorkflows(
              withBrowser(
                withReminders(
                  withGmail(
                    withCalendar(
                      withGoogle(LifeOpsServiceBase),
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
