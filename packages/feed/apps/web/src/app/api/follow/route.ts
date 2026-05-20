import { BusinessLogicError, withErrorHandling } from "@feed/api";
import type { NextRequest } from "next/server";
import {
  DELETE as deleteFollow,
  GET as getFollow,
  POST as postFollow,
} from "../users/[userId]/follow/route";

async function resolveUserId(request: NextRequest): Promise<string> {
  const { searchParams } = new URL(request.url);
  const queryUserId = searchParams.get("userId")?.trim();

  if (queryUserId) {
    return queryUserId;
  }

  const body = await request.json().catch(() => null);
  const bodyUserId = typeof body?.userId === "string" ? body.userId.trim() : "";

  if (bodyUserId) {
    return bodyUserId;
  }

  throw new BusinessLogicError("userId is required", "USER_ID_REQUIRED");
}

function toContext(userId: string) {
  return {
    params: Promise.resolve({ userId }),
  };
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const userId = await resolveUserId(request);
  return postFollow(request, toContext(userId));
});

export const DELETE = withErrorHandling(async (request: NextRequest) => {
  const userId = await resolveUserId(request);
  return deleteFollow(request, toContext(userId));
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const userId = await resolveUserId(request);
  return getFollow(request, toContext(userId));
});
