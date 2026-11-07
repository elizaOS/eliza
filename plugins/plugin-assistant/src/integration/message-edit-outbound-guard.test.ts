/** Proves MESSAGE op=edit applies the send path's outbound policy before the connector's edit hook delivers the replacement text. */
import {
  ChannelType,
  type Content,
  ENVELOPE_LEAK_NOTICE,
  type Memory,
  runWithTrajectoryContext,
  SecretSwapSession,
  type UUID,
  wrapExternalContent,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers";
import { messageAction } from "../features/advanced-capabilities/actions/message";

it("edit delivers replacement text through the send path's outbound policy", async () => {
  const f = await createIsolatedTestDatabase("message-edit-outbound-guard");
  const worldId = "33333333-3333-4333-8333-333333333333" as UUID;
  const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
  const userId = "55555555-5555-4555-8555-555555555555" as UUID;
  const edited: Content[] = [];
  try {
    await f.runtime.createEntity({
      id: userId,
      names: ["Owner"],
      agentId: f.testAgentId,
    });
    await f.runtime.ensureWorldExists({
      id: worldId,
      name: "Slack",
      agentId: f.testAgentId,
    });
    await f.runtime.ensureRoomExists({
      worldId,
      id: roomId,
      source: "slack",
      type: ChannelType.GROUP,
      channelId: "C0GENERAL",
    });
    await f.runtime.ensureParticipantInRoom(userId, roomId);
    f.runtime.registerMessageConnector({
      source: "slack",
      label: "Slack",
      capabilities: ["edit_message"],
      supportedTargetKinds: ["room", "channel"],
      contexts: ["social"],
      editHandler: async (_runtime, { content }) => {
        edited.push(content);
        return undefined;
      },
    });
    const message: Memory = {
      id: "77777777-7777-4777-8777-777777777777" as UUID,
      agentId: f.testAgentId,
      entityId: userId,
      roomId,
      content: { text: "fix your last message", source: "slack" },
      metadata: { type: "message", source: "slack" },
    };
    const edit = (text: string) =>
      messageAction.handler(f.runtime, message, undefined, {
        parameters: { action: "edit", messageId: "1712345678.000200", text },
      });

    expect(
      await edit(
        "<think>the owner said not to tell Bob about the layoffs</think>Fixed the typo.",
      ),
    ).toMatchObject({ success: true });
    await edit(
      `Here is the email:\n${wrapExternalContent(
        "Hi, the wire for invoice 4471 goes out Friday.",
        { source: "email", sender: "cfo@example.com", subject: "Invoice" },
      )}`,
    );
    const secretSwapSession = new SecretSwapSession({
      knownSecrets: { DEPLOY_TOKEN: "dpl_4f9c2a7e81b34d6f" },
    });
    await runWithTrajectoryContext({ secretSwapSession }, () =>
      edit("Deployed with dpl_4f9c2a7e81b34d6f."),
    );
    await edit("Use `<think>` tags in the prompt.");
    const reasoningOnly = await edit("<think>only reasoning</think>");

    expect(edited.map((content) => content.text)).toEqual([
      "Fixed the typo.",
      ENVELOPE_LEAK_NOTICE,
      "Deployed with [redacted credential].",
      "Use `<think>` tags in the prompt.",
    ]);
    expect(reasoningOnly).toMatchObject({ success: false });
    expect(
      f.runtime
        .getRecentReportedErrors()
        .filter((entry) => entry.scope === "outbound-envelope-guard")
        .map((entry) => entry.context?.seam),
    ).toEqual(["MESSAGE.edit"]);
  } finally {
    await f.cleanup();
  }
});
