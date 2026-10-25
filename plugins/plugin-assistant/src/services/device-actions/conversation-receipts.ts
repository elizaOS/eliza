import type { IAgentRuntime, Memory } from "@elizaos/core";
import { revalidateOwnerExclusiveDisclosure } from "@elizaos/core";
import { validateDevicePayload } from "./contract.ts";
import { deviceActionEffectReceipts } from "./effect-receipts.ts";
import { isNotesOperation, validateNotesResult } from "./notes-contract.ts";
import { DeviceActionService, getDeviceActionTurn } from "./service.ts";

/** Fresh authenticated queue truth, scoped to the original user messages in this conversation.
 * These historical receipts never supply a current native-record revision or new effect authority. */
export async function readDeviceConversationReceipts(
  runtime: IAgentRuntime,
  message: Memory,
) {
  const current = getDeviceActionTurn(),
    credential = current?.credential;
  if (
    !current ||
    !credential ||
    current.runtime !== runtime ||
    !current.isCurrent() ||
    current.replyConversation?.roomId !== message.roomId ||
    message.agentId !== runtime.agentId ||
    message.entityId === runtime.agentId ||
    message.content.role === "system"
  )
    return [];
  // The host maps an authenticated owner identity to its canonical conversation entity.
  // Those IDs are intentionally distinct; owner-exclusive disclosure proves the entity.
  const subject = credential.subjectUserId,
    actor = message.entityId,
    installation = credential.installationId,
    key = credential.deviceKey;
  const currentMessageId = message.id,
    room = message.roomId;
  const assertCurrent = () => {
    if (
      getDeviceActionTurn() !== current ||
      !current.active ||
      !current.isCurrent() ||
      current.runtime !== runtime ||
      current.replyConversation?.roomId !== room ||
      message.roomId !== room ||
      message.id !== currentMessageId ||
      message.entityId !== actor ||
      current.credential.subjectUserId !== subject ||
      current.credential.installationId !== installation ||
      current.credential.deviceKey !== key
    )
      throw Error("Device receipt context retired");
  };
  assertCurrent();
  if (!(await revalidateOwnerExclusiveDisclosure(runtime, message)).allowed)
    return [];
  assertCurrent();
  const stored = message.id ? await runtime.getMemoryById(message.id) : null;
  assertCurrent();
  if (
    !stored ||
    stored.agentId !== runtime.agentId ||
    stored.entityId !== actor ||
    stored.roomId !== room ||
    stored.content.role === "system"
  )
    return [];
  const service = new DeviceActionService(runtime),
    binding = await service.context(credential);
  assertCurrent();
  const requests = await service.recentCompletedNotes(credential);
  assertCurrent();
  const receipts = [];
  for (const request of requests) {
    if (receipts.length === 6) break;
    const payload = validateDevicePayload(request.payload),
      execution = request.execution,
      provider = execution?.providerReceipt;
    if (
      request.subjectUserId !== subject ||
      request.state !== "done" ||
      payload.workflow ||
      payload.installationId !== installation ||
      payload.enrollmentId !== binding.enrollmentId ||
      !payload.requestMessageId ||
      !execution ||
      provider?.outcome !== "applied" ||
      typeof provider.operationId !== "string" ||
      !provider.operationId
    )
      continue;
    const original = await runtime.getMemoryById(payload.requestMessageId);
    assertCurrent();
    if (
      !original ||
      original.agentId !== runtime.agentId ||
      original.entityId !== actor ||
      original.roomId !== room ||
      original.content.role === "system"
    )
      continue;
    if (isNotesOperation(payload.operation))
      validateNotesResult(payload.operation, provider.result);
    const effects = deviceActionEffectReceipts({
      request,
      reused: true,
    }).filter((receipt) => receipt.outcome === "applied");
    if (effects.length !== 1) continue;
    receipts.push({
      proposalId: request.id,
      requestMessageId: payload.requestMessageId,
      operation: payload.operation.type,
      ...(payload.operation.type === "create_note"
        ? { label: payload.operation.title }
        : {}),
      state: "done" as const,
      outcome: "applied" as const,
      completedAt: request.updatedAt.toISOString(),
      historicalEffect: {
        receiptId: effects[0].receiptId,
        operation: effects[0].operation,
        outcome: effects[0].outcome,
        commit: effects[0].commit,
      },
    });
  }
  assertCurrent();
  const finalBinding = await service.context(credential);
  assertCurrent();
  if (finalBinding.enrollmentId !== binding.enrollmentId) return [];
  if (!(await revalidateOwnerExclusiveDisclosure(runtime, message)).allowed)
    return [];
  assertCurrent();
  return receipts;
}
