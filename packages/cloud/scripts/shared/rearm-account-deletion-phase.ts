/**
 * Operator CLI that re-arms one account-deletion phase parked at
 * ACCOUNT_DELETION_PHASE_ATTEMPTS_EXHAUSTED, after the cause has been fixed.
 * Connects through the package's normal database resolution (point
 * `DATABASE_URL` at staging or production) and prints the matching receipt.
 * The receipt is reset only when `--apply` is passed; dry-run is the default.
 * A phase that already reached its provider resumes as `reconciling`, so the
 * saga inspects before it mutates again.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun packages/cloud/scripts/shared/rearm-account-deletion-phase.ts \
 *     --request <request-id> --phase <phase> [--apply]
 */

import process from "node:process";

const USAGE = "Usage: --request <request-id> --phase <phase> [--apply]\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): {
  requestId: string;
  phase: string;
  apply: boolean;
} {
  let requestId: string | undefined;
  let phase: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--request") requestId = argv[++index];
    else if (arg === "--phase") phase = argv[++index];
    else {
      process.stderr.write(`Unknown argument: ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!requestId || !UUID.test(requestId) || !phase) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  return { requestId, phase, apply };
}

async function main(): Promise<void> {
  const { requestId, phase, apply } = parseArgs(process.argv.slice(2));
  const { dbWrite, closeDatabaseConnectionsForTests } = await import(
    "../../shared/src/db/client"
  );
  const { and, eq, inArray } = await import("drizzle-orm");
  const { accountDeletionPhaseReceipts } = await import(
    "../../shared/src/db/schemas/account-deletion-phase-receipts"
  );
  const { accountDeletionRequests } = await import(
    "../../shared/src/db/schemas/account-deletion-requests"
  );

  const report = await dbWrite.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: accountDeletionRequests.id,
        status: accountDeletionRequests.status,
      })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, requestId))
      .for("update");
    if (!request) return { requestId, phase, outcome: "request_not_found" };
    if (request.status !== "scheduled" && request.status !== "processing") {
      return {
        requestId,
        phase,
        requestStatus: request.status,
        outcome: "request_not_running",
      };
    }
    const exhausted = and(
      eq(accountDeletionPhaseReceipts.request_id, requestId),
      eq(accountDeletionPhaseReceipts.phase, phase),
      eq(accountDeletionPhaseReceipts.status, "action_required"),
      eq(
        accountDeletionPhaseReceipts.last_error_code,
        "ACCOUNT_DELETION_PHASE_ATTEMPTS_EXHAUSTED",
      ),
    );
    const [receipt] = await tx
      .select({
        id: accountDeletionPhaseReceipts.id,
        attemptCount: accountDeletionPhaseReceipts.attempt_count,
        maxAttempts: accountDeletionPhaseReceipts.max_attempts,
        beforeProviderCallAt:
          accountDeletionPhaseReceipts.before_provider_call_at,
        updatedAt: accountDeletionPhaseReceipts.updated_at,
      })
      .from(accountDeletionPhaseReceipts)
      .where(exhausted)
      .for("update");
    if (!receipt) return { requestId, phase, outcome: "phase_not_exhausted" };
    const resumeStatus = receipt.beforeProviderCallAt
      ? "reconciling"
      : "pending";
    if (!apply)
      return { requestId, phase, receipt, resumeStatus, outcome: "dry_run" };
    const now = new Date();
    const rearmed = await tx
      .update(accountDeletionPhaseReceipts)
      .set({
        status: resumeStatus,
        attempt_count: 0,
        retry_class: null,
        next_attempt_at: null,
        last_error_code: null,
        updated_at: now,
      })
      .where(and(exhausted, eq(accountDeletionPhaseReceipts.id, receipt.id)))
      .returning({ id: accountDeletionPhaseReceipts.id });
    await tx
      .update(accountDeletionRequests)
      .set({ next_reconcile_at: null, updated_at: now })
      .where(
        and(
          eq(accountDeletionRequests.id, requestId),
          inArray(accountDeletionRequests.status, ["scheduled", "processing"]),
        ),
      );
    return {
      requestId,
      phase,
      resumeStatus,
      outcome: rearmed.length === 1 ? "rearmed" : "phase_changed",
    };
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await closeDatabaseConnectionsForTests();
}

await main();
