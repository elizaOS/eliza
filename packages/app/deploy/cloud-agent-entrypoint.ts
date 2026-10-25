/**
 * Cloud Agent Entrypoint (main)
 *
 * Full-featured cloud agent with auth, chat mode, complete history,
 * and body-size guards. All logic lives in cloud-agent-shared.ts.
 */

import { startCloudAgent } from "./cloud-agent-shared.ts";

startCloudAgent({
  bridgeSecret: process.env.BRIDGE_SECRET ?? "",
  maxBodyBytes: 1_048_576,
  enableChatMode: true,
});
