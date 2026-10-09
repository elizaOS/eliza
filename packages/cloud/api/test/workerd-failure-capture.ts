/** Stores complete fixture error details privately and emits only fixed, allowlisted failure classifications. */
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const errorNode = z.object({
  kind: z.enum(["error", "non-error"]),
  name: z.string().nullable(),
  message: z.string().nullable(),
  stack: z.string().nullable(),
  code: z.union([z.string(), z.number()]).nullable(),
  failureName: z.string().nullable(),
  retryable: z.boolean().nullable(),
});
const failureRecord = z.object({
  schema: z.literal(1),
  causes: z.array(errorNode).min(1),
  cyclicCause: z.boolean(),
});
const publicFailureNames = new Set([
  "SharedRuntimeActionContractError",
  "SharedRuntimeNoReplyError",
  "SharedRuntimeProviderConfigurationError",
  "SharedRuntimeProviderRejectedError",
  "SharedRuntimeProviderUnavailableError",
  "SharedRuntimeTimeoutError",
  "SharedRuntimeUnknownError",
]);

function failureSite(causes: z.infer<typeof errorNode>[]): string {
  for (const cause of causes) {
    if (
      cause.message ===
      "Eliza Shared runtime completed without a user-visible reply"
    )
      return "missing-user-visible-reply";
    const required = cause.message?.match(
      /^Eliza Shared runtime completed an executable (GENERATE_MEDIA|REMINDERS|TODO) request without an action result$/,
    );
    if (required) return `missing-required-${required[1]}-result`;
  }
  return "unclassified";
}

export async function createPrivateWorkerdFailureCapture(
  log: (summary: string) => void = console.error,
) {
  const directory = await mkdtemp(join(tmpdir(), "workerd-fixture-failure-"));
  await chmod(directory, 0o700);
  return {
    directory,
    async fetch(request: Request): Promise<Response> {
      const record = failureRecord.parse(await request.json());
      const receiptId = randomUUID();
      await writeFile(
        join(directory, `${receiptId}.json`),
        JSON.stringify(record, null, 2),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      const classified = record.causes.find(
        (cause) =>
          cause.failureName !== null &&
          publicFailureNames.has(cause.failureName),
      );
      log(
        `[workerd-fixture-failure] ${JSON.stringify({
          receiptId,
          failureName: classified?.failureName ?? "unclassified",
          retryable: classified?.retryable ?? null,
          site: failureSite(record.causes),
        })}`,
      );
      return new Response(null, { status: 204 });
    },
  };
}
