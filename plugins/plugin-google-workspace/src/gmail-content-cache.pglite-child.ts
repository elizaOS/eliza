/** Runs one side of Gmail segmented-cache fresh-process PGLite continuity. */

import { ChannelType, stringToUuid, type UUID } from "@elizaos/core/node";
import { createTestRuntime } from "@elizaos/core/testing";
import {
  buildGmailContentPublication,
  gmailContentReference,
  loadGmailContentManifest,
  publishGmailContent,
  readGmailContentPage,
} from "./gmail-content-cache.js";

const [mode, pgliteDir, reference] = process.argv.slice(2);
if (!mode || !pgliteDir) throw new Error("mode and PGLite directory are required");
const ownerEntityId = stringToUuid("gmail-cache-pglite-owner");
const roomId = stringToUuid("gmail-cache-pglite-room");
const worldId = stringToUuid("gmail-cache-pglite-world");
const { runtime, cleanup } = await createTestRuntime({
  characterName: "GmailCacheFreshProcess",
  pgliteDir,
  removePgliteDirOnCleanup: false,
});
try {
  const authorization = { ownerEntityId, roomId, accountId: "account-pglite" };
  if (mode === "write") {
    await runtime.createEntity({
      id: ownerEntityId,
      names: ["Gmail Cache Owner"],
      agentId: runtime.agentId,
    });
    await runtime.createWorld({ id: worldId, name: "Gmail Cache World", agentId: runtime.agentId });
    await runtime.createRoom({
      id: roomId,
      source: "gmail-cache-test",
      type: ChannelType.DM,
      worldId,
    });
    const body = `${"x".repeat(1024 * 1024)}FRESH-PROCESS-CANARY`;
    const projection = buildGmailContentPublication({
      runtime,
      ownerEntityId,
      roomId,
      accountId: authorization.accountId,
      messageId: "message-pglite",
      providerRevision: "history-pglite",
      text: body,
    });
    const status = await publishGmailContent({ runtime, projection, expectedRevision: null });
    if (status !== "published") throw new Error("PGLite publication conflicted");
    process.stdout.write(
      `GMAIL_CACHE_RESULT=${JSON.stringify({ reference: gmailContentReference(projection.head.id as UUID) })}\n`
    );
  } else if (mode === "read") {
    if (!reference) throw new Error("reader reference is required");
    const loaded = await loadGmailContentManifest({ runtime, reference, authorization });
    const offset = 1024 * 1024;
    const page = await readGmailContentPage({
      runtime,
      loaded,
      authorization,
      unit: "byte",
      offset,
      limit: Buffer.byteLength("FRESH-PROCESS-CANARY"),
    });
    process.stdout.write(
      `GMAIL_CACHE_RESULT=${JSON.stringify({ text: page.text, sourceWork: page.sourceWork })}\n`
    );
  } else throw new Error(`unsupported mode: ${mode}`);
} finally {
  await cleanup();
}
