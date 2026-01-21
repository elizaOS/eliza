import {
  badRequest,
  notFound,
  ok,
  parseBody,
  toProfileData,
  unauthorized,
} from "@/lib/api-utils";
import { generateRequestId, logger } from "@/lib/logger";
import { requireSessionUser } from "@/lib/session";
import { updateUserProfile } from "@/lib/store";
import { normalizeEmail, validateProfileUpdate } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const reqId = generateRequestId();
  const user = await requireSessionUser();

  if (!user) {
    logger.warn("Profile GET unauthorized", {}, reqId);
    return unauthorized();
  }

  logger.info("Profile fetched", { userId: user.id }, reqId);
  return ok(toProfileData(user));
}

export async function PUT(request: Request) {
  const reqId = generateRequestId();
  const user = await requireSessionUser();

  if (!user) {
    logger.warn("Profile PUT unauthorized", {}, reqId);
    return unauthorized();
  }

  const body =
    (await parseBody<{ name?: string; email?: string; location?: string }>(
      request,
    )) ?? {};
  const validation = validateProfileUpdate(body);

  if (!validation.valid) {
    logger.warn(
      "Profile validation failed",
      { userId: user.id, errors: validation.errors },
      reqId,
    );
    return badRequest(Object.values(validation.errors)[0], {
      errors: validation.errors,
    });
  }

  const updated = await updateUserProfile(user.id, {
    name: body.name?.trim() || null,
    email: body.email ? normalizeEmail(body.email) : null,
    location: body.location?.trim() || null,
  });

  if (!updated) {
    logger.error("Profile not found on update", { userId: user.id }, reqId);
    return notFound("Profile not found.");
  }

  logger.info("Profile updated", { userId: user.id }, reqId);
  return ok(toProfileData(updated));
}
