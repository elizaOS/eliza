import { runWithCloudBindings } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  createDurableVoiceUsageStore,
  importCloudflareVoiceUsage,
} from "@elizaos/cloud-shared/lib/services/voice-usage-meter";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type {
  VoiceUsageIdentity,
  VoiceUsageLimits,
} from "@elizaos/host/voice/usage";
import { Hono } from "hono";
import twilioRoute from "../../v1/twilio/voice/media/route";
import voiceRoute from "../../v1/voice/session/ws/route";

export { AuthenticationState } from "../../src/authentication-state";
export { VoiceUsageState } from "../../src/voice-usage-state";

const app = new Hono<AppEnv>();
app.use("*", (c, next) => runWithCloudBindings(c.env, next));
app.post("/", async (c) => {
  const input = await c.req.json<{
    operation: string;
    identity: VoiceUsageIdentity;
    minutes: number;
    limits: VoiceUsageLimits;
    now?: number;
    orgKey: string;
    entries: Array<{ key: string; value: number; expiresAt: number }>;
  }>();
  try {
    if (input.operation === "import") {
      if (!c.env.VOICE_USAGE_STATE) throw new Error("Missing fixture binding");
      await importCloudflareVoiceUsage(
        c.env.VOICE_USAGE_STATE,
        input.orgKey,
        input.entries,
        true,
      );
      return c.json({ imported: true });
    }
    const store = createDurableVoiceUsageStore(
      c.env,
      input.now === undefined ? undefined : () => input.now as number,
    );
    if (!store) throw new Error("Missing fixture store");
    if (input.operation === "release") {
      await store.release(input.identity, input.minutes);
      return c.json({ released: true });
    }
    return c.json(
      await store.checkAndRecord(input.identity, input.minutes, input.limits),
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : "unknown",
      },
      503,
    );
  }
});
app.route("/voice", voiceRoute);
app.route("/twilio", twilioRoute);
export default app;
