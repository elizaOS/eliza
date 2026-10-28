/** Internal boundary for an exclusively owned connection; no retries or CLI.
 * Work must never issue transaction control or share the connection concurrently.
 */
export interface RecoveryTransactionClient {
  query(sql: string, parameters?: unknown[]): Promise<{ command?: string }>;
  getTransactionStatus():
    | "I"
    | "T"
    | "E"
    | null
    | Promise<"I" | "T" | "E" | null>;
}
export type RecoveryTransactionOutcome = {
  status:
    | "committed"
    | "aborted"
    | "rollback_unconfirmed"
    | "commit_unconfirmed"
    | "not_started"
    | "transaction_ownership_lost";
};

/** Only PostgreSQL's explicit COMMIT completion tag confirms a commit. */
export async function runRecoveryTransaction(
  client: RecoveryTransactionClient,
  work: () => Promise<void>,
): Promise<RecoveryTransactionOutcome> {
  try {
    if ((await client.getTransactionStatus()) !== "I")
      return { status: "not_started" };
  } catch {
    // error-policy:J1 no transaction was submitted; scrub driver details.
    return { status: "not_started" };
  }
  let commitSubmitted = false;
  try {
    const begin = await client.query("BEGIN");
    if (
      begin.command !== "BEGIN" ||
      (await client.getTransactionStatus()) !== "T"
    )
      throw Error("begin_unconfirmed");
    await work();
    const status = await client.getTransactionStatus();
    if (status === "I" || status === null)
      return { status: "transaction_ownership_lost" };
    if (status === "E") throw Error("work_transaction_failed");
    commitSubmitted = true;
    const result = await client.query("COMMIT");
    if (result.command === "ROLLBACK") return { status: "aborted" };
    if (
      result.command !== "COMMIT" ||
      (await client.getTransactionStatus()) !== "I"
    )
      return { status: "commit_unconfirmed" };
    return { status: "committed" };
  } catch {
    // error-policy:J1 expose no SQL, bound values, or raw database errors.
    if (commitSubmitted) return { status: "commit_unconfirmed" };
    try {
      const result = await client.query("ROLLBACK");
      return {
        status:
          result.command === "ROLLBACK" &&
          (await client.getTransactionStatus()) === "I"
            ? "aborted"
            : "rollback_unconfirmed",
      };
    } catch {
      // error-policy:J6 an unreachable connection cannot confirm rollback.
      return { status: "rollback_unconfirmed" };
    }
  }
}
