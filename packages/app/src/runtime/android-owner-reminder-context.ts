/** Private native identity read. This is not per-definition consent or notification readiness. */
import type { AgentNativeOwnerReminderContext } from "@elizaos/agent/runtime/host-bridge";
import { ElizaError } from "@elizaos/core/protocol";
import { requestAndroidPrivateHost } from "../security/android-private-host.js";

export async function readAndroidOwnerReminderContext(
  socketName: string,
  agentId: string,
  assertCurrent: () => void,
): Promise<AgentNativeOwnerReminderContext> {
  assertCurrent();
  if (!socketName || socketName.length > 256 || /[\0\r\n]/.test(socketName))
    throw new ElizaError("Native owner context is unavailable", {
      code: "NATIVE_OWNER_CONTEXT_UNAVAILABLE",
    });
  const reply = await requestAndroidPrivateHost(
    { operation: "nativeOwnerContext" },
    `\0${socketName}`,
  );
  assertCurrent();
  const value = reply.context;
  const fields = [
    "subjectUserId",
    "agentId",
    "installationId",
    "enrollmentId",
    "accountRef",
    "environment",
    "sessionGeneration",
  ] as const;
  if (!reply.ok || !value || typeof value !== "object" || Array.isArray(value))
    throw new ElizaError("Native owner context is unavailable", {
      code: "NATIVE_OWNER_CONTEXT_UNAVAILABLE",
    });
  const context = value as Record<string, unknown>;
  if (
    Object.keys(context).length !== fields.length + 1 ||
    context.protocol !== 1 ||
    fields.some(
      (key) =>
        typeof context[key] !== "string" ||
        !context[key].trim() ||
        context[key].length > 1024,
    ) ||
    context.agentId !== agentId
  )
    throw new ElizaError("Native owner context does not match this agent", {
      code: "NATIVE_OWNER_CONTEXT_MISMATCH",
    });
  const result = { protocol: 1 } as unknown as Record<string, unknown>;
  for (const field of fields) result[field] = context[field];
  assertCurrent();
  return Object.freeze(result) as unknown as AgentNativeOwnerReminderContext;
}
