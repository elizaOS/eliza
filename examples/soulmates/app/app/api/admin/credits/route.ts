import {
  badRequest,
  forbidden,
  notFound,
  ok,
  parseBody,
} from "@/lib/api-utils";
import { generateRequestId, logger } from "@/lib/logger";
import { requireAdminUser } from "@/lib/session";
import { addCredits } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const reqId = generateRequestId();
  const admin = await requireAdminUser();

  if (!admin) {
    logger.warn("Admin credits forbidden", {}, reqId);
    return forbidden();
  }

  const body = await parseBody<{ userId?: string; delta?: number }>(request);
  const userId = body?.userId ?? "";
  const delta =
    typeof body?.delta === "number" && Number.isFinite(body.delta)
      ? Math.trunc(body.delta)
      : 0;

  if (!userId || delta === 0) {
    logger.warn(
      "Admin credits invalid input",
      { userId, delta, adminId: admin.id },
      reqId,
    );
    return badRequest("Provide a user ID and non-zero delta.");
  }

  const updated = await addCredits(userId, delta, "admin_adjustment", admin.id);

  if (!updated) {
    logger.warn(
      "Admin credits user not found",
      { userId, adminId: admin.id },
      reqId,
    );
    return notFound("User not found.");
  }

  logger.info(
    "Admin credits adjusted",
    { userId, delta, newBalance: updated.credits, adminId: admin.id },
    reqId,
  );
  return ok(updated);
}
