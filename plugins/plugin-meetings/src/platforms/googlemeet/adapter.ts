/**
 * GoogleMeetAdapter — the platform's `MeetingPlatformAdapter`. Wires the
 * Chromium launch, the auto-selected humanized input driver, and the shared
 * meeting flow. Anonymous guest join only (no OAuth/cookies).
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason, MeetingPlatform } from "@elizaos/shared";
import type { MeetingBotSession, MeetingPlatformAdapter } from "../../types.js";
import { launchMeetingBrowser } from "../shared/launch.js";
import { runMeetingFlow } from "../shared/meeting-flow.js";
import { selectInputDriver } from "../humanized/index.js";
import { createGoogleMeetStrategies } from "./strategies.js";

export class GoogleMeetAdapter implements MeetingPlatformAdapter {
  readonly platform: MeetingPlatform = "google_meet";

  async run(session: MeetingBotSession): Promise<MeetingEndReason> {
    const input = await selectInputDriver();
    const browser = await launchMeetingBrowser({ channel: "chrome" });
    try {
      const strategies = createGoogleMeetStrategies(input);
      return await runMeetingFlow({
        page: browser.page,
        session,
        strategies,
        waitingRoomTimeoutMs: session.config.autoLeave.waitingRoomTimeoutMs,
      });
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "[GoogleMeetAdapter] unexpected failure",
      );
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      await browser.close();
    }
  }
}
