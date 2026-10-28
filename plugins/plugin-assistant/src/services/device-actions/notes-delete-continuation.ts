import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { ApprovalRequest } from "../approval/types.ts";
import { type DeviceActionPayload, validateDevicePayload } from "./contract.ts";
import { validateNotesOperation } from "./notes-contract.ts";
import { originalRequestsNotesDeletion } from "./notes-delete-intent.ts";
import { validateNotesQueryResult } from "./notes-query-result.ts";
import type { DeviceReadCompletion } from "./read-completion.ts";
import {
  assertDeviceReadCompletionCurrent,
  deviceReadResult,
  originalReadRequestMatches,
} from "./read-completion.ts";

/** The only supported continuation creates an ordinary pending approval, never a native effect. */
export function notesDeleteAfterReadPlan(
  runtime: IAgentRuntime,
  binding: DeviceReadCompletion,
  request: ApprovalRequest,
  original: Memory | null,
  signal: AbortSignal,
  assertHostCurrent?: () => void,
) {
  assertDeviceReadCompletionCurrent(
    runtime,
    binding,
    signal,
    assertHostCurrent,
  );
  if (
    binding.purpose !== "original_notes_delete_after_read" ||
    binding.origin.afterRead?.kind !== "notes_delete" ||
    !originalReadRequestMatches(binding, original, runtime)
  )
    throw Error("Original Notes deletion request changed");
  if (!originalRequestsNotesDeletion(original))
    throw Error("Original request did not authorize Notes deletion");
  const payload = validateDevicePayload(request.payload);
  if (
    payload.operation.type !== "notes_query" ||
    request.id !== binding.proposalId ||
    request.subjectUserId !== binding.ownerId ||
    payload.installationId !== binding.installationId ||
    payload.enrollmentId !== binding.enrollmentId
  )
    throw Error("Original Notes lookup scope changed");
  const result = validateNotesQueryResult(
    payload.operation,
    deviceReadResult(request),
  );
  if (result.basis === "no-match")
    return { text: "No matching note was shared. Nothing was deleted." };
  if (result.basis === "owner-choice-uncertain")
    return {
      text: "The lookup did not establish which note you meant. Nothing was deleted. Choose the exact note before continuing.",
    };
  const operation = validateNotesOperation({
    type: "notes_delete",
    target: result.target,
  });
  const nextPayload: DeviceActionPayload = {
    action: "device_action",
    version: 1,
    installationId: binding.installationId,
    enrollmentId: binding.enrollmentId,
    requestMessageId: binding.origin.original.id,
    operation,
  };
  return {
    text: "The note is ready for deletion review. Approve the exact note to delete it. Nothing has been deleted yet.",
    payload: nextPayload,
    idempotencyKey: `device-read-delete:${binding.proposalId}:${binding.digest}`,
  };
}
