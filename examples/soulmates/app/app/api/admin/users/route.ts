import {
  badRequest,
  forbidden,
  notFound,
  ok,
  parseBody,
} from "@/lib/api-utils";
import { requireAdminUser } from "@/lib/session";
import {
  listUsersPage,
  type UserCursor,
  type UserStatus,
  updateUserAdminFields,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const parseCursor = (value: string | null): UserCursor | null => {
  if (!value) return null;
  const [createdAt, id] = value.split("|");
  if (!createdAt || !id) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return { createdAt: date.toISOString(), id };
};

const parseStatus = (value: string | null): UserStatus | undefined => {
  if (value === "active" || value === "blocked") return value;
  return undefined;
};

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return forbidden();

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const status = parseStatus(url.searchParams.get("status"));
  const isAdminParam = url.searchParams.get("isAdmin");
  const isAdmin =
    isAdminParam === "true"
      ? true
      : isAdminParam === "false"
        ? false
        : undefined;
  const createdAfter =
    url.searchParams.get("createdAfter") ?? url.searchParams.get("createdAt");
  const createdBefore = url.searchParams.get("createdBefore");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const cursor = parseCursor(url.searchParams.get("cursor"));

  const result = await listUsersPage({
    q,
    status,
    isAdmin,
    createdAfter: createdAfter ?? undefined,
    createdBefore: createdBefore ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    cursor,
  });

  return ok(result);
}

export async function PATCH(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) return forbidden();

  const body = await parseBody<{
    userId?: string;
    status?: string;
    isAdmin?: boolean;
  }>(request);
  const userId = body?.userId ?? "";
  if (!userId) return badRequest("Missing userId.");

  const statusValue = body?.status;
  const status =
    statusValue === "active" || statusValue === "blocked"
      ? statusValue
      : statusValue
        ? null
        : undefined;
  if (status === null) return badRequest("Invalid status.");

  if (body?.isAdmin !== undefined && typeof body.isAdmin !== "boolean") {
    return badRequest("Invalid isAdmin flag.");
  }

  const updated = await updateUserAdminFields(userId, {
    status: status ?? undefined,
    isAdmin: body?.isAdmin,
  });
  if (!updated) return notFound("User not found.");
  return ok(updated);
}
