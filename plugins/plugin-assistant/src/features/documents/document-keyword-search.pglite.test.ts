import { randomUUID } from "node:crypto";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { DocumentService } from "./service.ts";

it("finds uploaded non-English documents by a keyword query in their own language", async () => {
  const owner = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  const worldId = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "KeywordSearchAcceptance",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.ensureConnection({
      entityId: owner,
      roomId,
      worldId,
      worldName: "Synthetic search",
      userName: "Owner",
      name: "Keyword search",
      source: "test",
      type: ChannelType.DM,
    });
    const service = new DocumentService(runtime);
    const access = {
      requesterEntityId: owner,
      role: "OWNER" as const,
      isOwner: true,
    };
    const add = (originalFilename: string, content: string) =>
      service.addDocument({
        agentId: runtime.agentId,
        entityId: owner,
        addedBy: owner,
        roomId,
        worldId,
        clientDocumentId: "" as UUID,
        originalFilename,
        contentType: "text/plain",
        content,
        scope: "owner-private",
      });
    await add("returns.txt", "Refunds are issued within fourteen days.");
    await add(
      "vozvrat.txt",
      "Возврат средств оформляется в течение десяти дней.",
    );
    await add("hwanbul.txt", "환불은 영업일 기준 칠일 이내에 처리됩니다.");

    const search = async (text: string) =>
      (
        await service.searchDocuments(
          createMessageMemory({
            entityId: owner,
            agentId: runtime.agentId,
            roomId,
            content: { text },
          }),
          undefined,
          "keyword",
          access,
        )
      ).map((match) => match.content.text);

    expect(await search("Как оформляется возврат средств?")).toEqual([
      "Возврат средств оформляется в течение десяти дней.",
    ]);
    expect(await search("환불은 언제 처리됩니까?")).toEqual([
      "환불은 영업일 기준 칠일 이내에 처리됩니다.",
    ]);
    expect(await search("When are refunds issued?")).toEqual([
      "Refunds are issued within fourteen days.",
    ]);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
