import type { IAgentRuntime, Memory } from "@elizaos/core";
import { inferSelectedNotesUpdate } from "../../../../plugin-notes/src/native-note-update.ts";
import type { ApprovalRequest } from "../approval/types.ts";
import { type DeviceActionPayload, validateDevicePayload } from "./contract.ts";
import {
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";
import { validateNotesQueryResult } from "./notes-query-result.ts";
import {
  assertDeviceReadCompletionCurrent,
  type DeviceReadCompletion,
  deviceReadResult,
  originalReadRequestMatches,
} from "./read-completion.ts";
/** Existing selected read + approved snapshot + canonical patch + separate native review. */
export async function notesUpdateAfterReadPlan(
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
  const queryResolution =
    binding.purpose === "original_notes_query_after_read" &&
    binding.origin.afterRead?.kind === "notes_query_resolution";
  if (
    !queryResolution &&
    (binding.purpose !== "original_notes_update_after_read" ||
      binding.origin.afterRead?.kind !== "notes_update")
  )
    throw Error("Original Notes edit continuation changed");
  if (!originalReadRequestMatches(binding, original, runtime) || !original)
    throw Error("Original Notes edit request changed");
  const payload = validateDevicePayload(request.payload);
  if (
    (queryResolution
      ? payload.operation.type !== "notes_query"
      : payload.operation.type !== "notes_read_selected") ||
    request.id !== binding.proposalId ||
    request.subjectUserId !== binding.ownerId ||
    payload.installationId !== binding.installationId ||
    payload.enrollmentId !== binding.enrollmentId
  )
    throw Error("Original Notes selected read scope changed");
  let target, result;
  if (payload.operation.type === "notes_query") {
    const queried = validateNotesQueryResult(
      payload.operation,
      deviceReadResult(request),
    );
    // A no-match or uncertain lookup is not update authority. Keep its truthful
    // existing read response; never fall back to an inferred/managed target.
    if (
      payload.operation.query.kind !== "title" ||
      queried.basis !== "title-match"
    )
      return;
    target = queried.target;
    result = queried.record;
  } else if (payload.operation.type === "notes_read_selected") {
    target = payload.operation.target;
    result = validateNotesResult(payload.operation, deviceReadResult(request));
  } else throw Error("Original Notes read operation changed");
  if (!result.fields) throw Error("Approved Notes fields unavailable");
  const plan = await inferSelectedNotesUpdate({
    runtime,
    message: original,
    fields: result.fields,
    signal,
  });
  assertDeviceReadCompletionCurrent(
    runtime,
    binding,
    signal,
    assertHostCurrent,
  );
  if (!plan.fields)
    return queryResolution && plan.noChange ? undefined : { text: plan.text };
  const operation = validateNotesOperation({
    type: "notes_update",
    target,
    fields: plan.fields,
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
    text: plan.text,
    payload: nextPayload,
    idempotencyKey: `device-read-notes-update:${binding.proposalId}:${binding.digest}`,
  };
}
