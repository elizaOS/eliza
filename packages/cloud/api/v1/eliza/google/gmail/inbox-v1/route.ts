import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  managedInboxProvider,
  managedInboxReceipts,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector/inbox-managed";
import { createInboxOperationRoutes } from "@elizaos/cloud-shared/lib/services/agent-google-connector/inbox-operation-routes";
import {
  DefiniteProviderRejection,
  InboxContractError,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector/inbox-receipts";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
async function identity(context: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(context);
  await requirePrivateOwnerAccess(context, user);
  return { organizationId: user.organization_id, userId: user.id };
}
async function selected(context: AppContext) {
  const user = await identity(context),
    grantId = context.req.query("grantId");
  if (
    !grantId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      grantId,
    )
  )
    throw new InboxContractError(400, "Explicit grant UUID required");
  return { ...user, grantId };
}
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
      : failureResponse(context, error),
);
app.get("/capabilities", async (context) =>
  context.json(
    await managedInboxProvider.capabilities(await selected(context)),
  ),
);
app.get("/thread", async (context) =>
  context.json(
    await managedInboxProvider.thread(
      await selected(context),
      context.req.query("threadId") ?? "",
      Number(context.req.query("offset") ?? "0"),
      context.req.query("historyId"),
    ),
  ),
);
app.get("/attachment", async (context) =>
  context.json(
    await (context.req.query("opaque") === "1"
      ? managedInboxProvider.opaqueAttachment
      : managedInboxProvider.attachment
    ).call(
      managedInboxProvider,
      await selected(context),
      context.req.query("messageId") || "",
      context.req.query("partId") || "",
      context.req.query("historyId") || "",
    ),
  ),
);
app.get("/drafts", async (context) =>
  context.json(
    await managedInboxProvider.drafts(
      await selected(context),
      context.req.query("pageToken"),
    ),
  ),
);
app.get("/draft", async (context) => {
  if (context.req.query("content") === "1")
    return context.json(
      await managedInboxProvider.draftContent(
        await selected(context),
        context.req.query("draftId") ?? "",
      ),
    );
  const { raw: _raw, ...metadata } = await managedInboxProvider.draft(
    await selected(context),
    context.req.query("draftId") ?? "",
  );
  return context.json(metadata);
});
app.route(
  "/",
  createInboxOperationRoutes({
    receipts: managedInboxReceipts,
    authenticate: (context) => identity(context as AppContext),
    review: (owner, proposal, requestId) =>
      managedInboxProvider.review(owner, proposal, requestId),
    onError: (error, context) => failureResponse(context as AppContext, error),
  }),
);
export default app;
