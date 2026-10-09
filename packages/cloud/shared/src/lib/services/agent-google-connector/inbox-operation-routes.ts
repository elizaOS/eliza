import { type Context, Hono } from "hono";
import {
  DefiniteProviderRejection,
  dispatchInboxEffect,
  InboxContractError,
  type InboxEffectKind,
  type InboxOwner,
  type InboxReceipts,
} from "./inbox-receipts";

export interface InboxReviewedEffect {
  kind: InboxEffectKind;
  digest: string;
  review: Record<string, unknown>;
  perform: () => Promise<Record<string, unknown>>;
}
export interface InboxOperationRouteDependencies {
  receipts: InboxReceipts;
  onError?(error: Error, context: Context): Response | Promise<Response>;
  authenticate(context: Context): Promise<Omit<InboxOwner, "grantId">>;
  /** Must resolve the exact managed owner grant and validate scopes/content on each call. */
  review(owner: InboxOwner, proposal: unknown, requestId: string): Promise<InboxReviewedEffect>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InboxContractError(400, "A UUID identity is required");
  return value;
}
async function input(context: Context, keys: string[]): Promise<Record<string, unknown>> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw new InboxContractError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new InboxContractError(413, "Inbox review exceeds the explicit size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InboxContractError(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InboxContractError(400, "JSON object required");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in result))
  )
    throw new InboxContractError(400, "Unexpected or missing Inbox fields");
  return result;
}
/** Mounted below the managed Gmail inbox-v1 namespace. All effects require prepare then a matching explicit dispatch. */
export function createInboxOperationRoutes(dependencies: InboxOperationRouteDependencies) {
  const app = new Hono();
  app.onError((error, context) =>
    error instanceof DefiniteProviderRejection
      ? context.json(
          {
            error:
              "The selected Google account or message is unavailable. Reconnect Google or refresh the selection.",
          },
          error.code === "404" ? 404 : 409,
        )
      : error instanceof InboxContractError
        ? context.json({ error: error.message }, error.status)
        : dependencies.onError
          ? dependencies.onError(error, context)
          : context.json(
              {
                error:
                  "Inbox operation unavailable; inspect the canonical receipt before attempting another action.",
              },
              503,
            ),
  );
  app.post("/operations", async (context) => {
    const identity = await dependencies.authenticate(context),
      body = await input(context, ["grantId", "requestId", "proposal"]),
      owner = { ...identity, grantId: id(body.grantId) },
      requestId = id(body.requestId);
    const reviewed = await dependencies.review(owner, body.proposal, requestId);
    const receipt = await dependencies.receipts.prepare(
      owner,
      requestId,
      reviewed.kind,
      reviewed.digest,
    );
    return context.json({
      version: 1,
      receipt,
      review: reviewed.review,
      providerExactlyOnce: false,
    });
  });
  app.post("/operations/:requestId/dispatch", async (context) => {
    const identity = await dependencies.authenticate(context),
      body = await input(context, ["grantId", "reviewDigest", "proposal"]),
      owner = { ...identity, grantId: id(body.grantId) },
      requestId = id(context.req.param("requestId"));
    if (typeof body.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewDigest))
      throw new InboxContractError(400, "Review digest required");
    const existing = await dependencies.receipts.get(owner, requestId);
    if (existing.reviewDigest !== body.reviewDigest)
      throw new InboxContractError(409, "Review changed");
    // Even if authorization has since expired, GET can inspect the caller's own receipt.
    // A repeated dispatch never retrieves new credentials or repeats the provider request.
    if (existing.state !== "prepared")
      return context.json({
        version: 1,
        receipt: existing,
        providerExactlyOnce: false,
      });
    const reviewed = await dependencies.review(owner, body.proposal, requestId);
    if (reviewed.digest !== body.reviewDigest || reviewed.kind !== existing.kind)
      throw new InboxContractError(409, "Reviewed content or provider state changed");
    const receipt = await dispatchInboxEffect({
      receipts: dependencies.receipts,
      owner,
      requestId,
      reviewDigest: reviewed.digest,
      perform: reviewed.perform,
    });
    return context.json({ version: 1, receipt, providerExactlyOnce: false });
  });
  app.get("/operations/:requestId", async (context) => {
    const identity = await dependencies.authenticate(context),
      owner = { ...identity, grantId: id(context.req.query("grantId")) };
    return context.json({
      version: 1,
      receipt: await dependencies.receipts.observe(owner, id(context.req.param("requestId"))),
      providerExactlyOnce: false,
    });
  });
  return app;
}
