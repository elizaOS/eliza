import { type SQL, sql } from "drizzle-orm";

export interface InboxOwner {
  organizationId: string;
  userId: string;
  grantId: string;
}
export type InboxEffectKind =
  | "send"
  | "draft-create"
  | "draft-replace"
  | "draft-delete"
  | "archive"
  | "unarchive"
  | "trash"
  | "untrash"
  | "mark-read"
  | "mark-unread";
export type InboxReceiptState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "rejected"
  | "outcome-unknown";
export interface InboxReceipt {
  requestId: string;
  kind: InboxEffectKind;
  reviewDigest: string;
  state: InboxReceiptState;
  providerResult: Record<string, unknown> | null;
  rejectionCode: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
}
export type InboxDatabase = (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
export class InboxContractError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 502,
    message: string,
  ) {
    super(message);
  }
}
function receipt(row: Record<string, unknown>): InboxReceipt {
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
  return {
    requestId: String(row.request_id),
    kind: row.kind as InboxEffectKind,
    reviewDigest: String(row.review_digest),
    state: row.state as InboxReceiptState,
    providerResult: row.provider_result as Record<string, unknown> | null,
    rejectionCode: row.rejection_code as string | null,
    createdAt: date(row.created_at),
    dispatchedAt: row.dispatched_at ? date(row.dispatched_at) : null,
    finishedAt: row.finished_at ? date(row.finished_at) : null,
  };
}
/** All reads use the writer: replica lag cannot justify a second provider effect. */
export class InboxReceipts {
  constructor(private readonly database: InboxDatabase) {}
  private scope(owner: InboxOwner, requestId: string) {
    return sql`organization_id=${owner.organizationId} AND user_id=${owner.userId} AND grant_id=${owner.grantId} AND request_id=${requestId}`;
  }
  async get(owner: InboxOwner, requestId: string): Promise<InboxReceipt> {
    const result = await this.database(
      sql`SELECT * FROM managed_gmail_operation_receipts WHERE ${this.scope(owner, requestId)}`,
    );
    if (result.rows.length !== 1) throw new InboxContractError(404, "Operation not found");
    return receipt(result.rows[0]);
  }
  async prepare(
    owner: InboxOwner,
    requestId: string,
    kind: InboxEffectKind,
    digest: string,
  ): Promise<InboxReceipt> {
    await this.database(
      sql`INSERT INTO managed_gmail_operation_receipts (organization_id,user_id,grant_id,request_id,kind,review_digest) VALUES (${owner.organizationId},${owner.userId},${owner.grantId},${requestId},${kind},${digest}) ON CONFLICT DO NOTHING`,
    );
    const current = await this.get(owner, requestId);
    if (current.kind !== kind || current.reviewDigest !== digest)
      throw new InboxContractError(
        409,
        "Request ID is already bound to a different reviewed operation",
      );
    return current;
  }
  async claim(owner: InboxOwner, requestId: string, digest: string): Promise<boolean> {
    const result = await this.database(
      sql`UPDATE managed_gmail_operation_receipts SET state='dispatched',dispatched_at=now() WHERE ${this.scope(owner, requestId)} AND review_digest=${digest} AND state='prepared' RETURNING request_id`,
    );
    return result.rows.length === 1;
  }
  async finish(
    owner: InboxOwner,
    requestId: string,
    state: "succeeded" | "rejected" | "outcome-unknown",
    result: Record<string, unknown> | null,
    code: string | null,
  ): Promise<InboxReceipt> {
    await this.database(
      sql`UPDATE managed_gmail_operation_receipts SET state=${state},provider_result=${result === null ? null : JSON.stringify(result)}::jsonb,rejection_code=${code},finished_at=now() WHERE ${this.scope(owner, requestId)} AND state='dispatched'`,
    );
    return this.get(owner, requestId);
  }
  async observe(owner: InboxOwner, requestId: string): Promise<InboxReceipt> {
    // A process may have died on either side of provider dispatch. Never reclaim it.
    await this.database(
      sql`UPDATE managed_gmail_operation_receipts SET state='outcome-unknown',finished_at=now() WHERE ${this.scope(owner, requestId)} AND state='dispatched' AND dispatched_at<now()-interval '90 seconds'`,
    );
    return this.get(owner, requestId);
  }
}
export class DefiniteProviderRejection extends Error {
  constructor(public readonly code: string) {
    super("Provider rejected the operation");
  }
}
/** Authorization and canonical review construction happen before entering this function.
 * Persisted dispatch wins once; neither an ambiguous result nor a repeated request retries Gmail. */
export async function dispatchInboxEffect(input: {
  receipts: InboxReceipts;
  owner: InboxOwner;
  requestId: string;
  reviewDigest: string;
  perform: () => Promise<Record<string, unknown>>;
}): Promise<InboxReceipt> {
  const { receipts, owner, requestId, reviewDigest } = input,
    current = await receipts.get(owner, requestId);
  if (current.reviewDigest !== reviewDigest)
    throw new InboxContractError(409, "Reviewed content changed");
  if (current.state !== "prepared" || !(await receipts.claim(owner, requestId, reviewDigest)))
    return receipts.get(owner, requestId);
  let result: Record<string, unknown>;
  try {
    result = await input.perform();
  } catch (error) {
    return receipts.finish(
      owner,
      requestId,
      error instanceof DefiniteProviderRejection ? "rejected" : "outcome-unknown",
      null,
      error instanceof DefiniteProviderRejection ? error.code : null,
    );
  }
  // A database error after provider success must propagate, not become a new send attempt.
  return receipts.finish(owner, requestId, "succeeded", result, null);
}
