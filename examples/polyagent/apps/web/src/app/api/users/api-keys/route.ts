/**
 * User API Keys API
 *
 * @route GET /api/users/api-keys - List user's API keys
 * @route POST /api/users/api-keys - Generate new API key
 * @access Authenticated (own keys only)
 */

import {
  authenticate,
  generateApiKey,
  hashApiKey,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { asUser, generateSnowflakeId, userApiKeys } from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const CreateApiKeySchema = z.object({
  name: z.string().optional(),
});

/**
 * GET /api/users/api-keys - List user's API keys
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  // Use asUser to enforce RLS
  const keys = await asUser(authUser.userId, async (dbClient) => {
    return await dbClient.query.userApiKeys.findMany({
      where: (keys, { eq, and: andFn, isNull: isNullFn }) =>
        andFn(eq(keys.userId, authUser.userId), isNullFn(keys.revokedAt)),
      orderBy: (keys, { desc }) => [desc(keys.createdAt)],
    });
  });

  // Mask keys - only show last 4 characters
  const maskedKeys = keys.map((key) => {
    const keyHash = key.keyHash;
    const last4 = keyHash.slice(-4);
    return {
      id: key.id,
      name: key.name,
      maskedKey: `bab_live_****${last4}`,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() || null,
      expiresAt: key.expiresAt?.toISOString() || null,
    };
  });

  logger.info(
    "API keys listed",
    { userId: authUser.userId, count: maskedKeys.length },
    "API Keys",
  );

  return successResponse({ keys: maskedKeys });
});

/**
 * POST /api/users/api-keys - Generate new API key
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const body = await request.json();
  const validated = CreateApiKeySchema.parse(body);

  // Generate API key
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyId = await generateSnowflakeId();

  // Use asUser to enforce RLS
  const createdKey = await asUser(authUser.userId, async (dbClient) => {
    return await dbClient
      .insert(userApiKeys)
      .values({
        id: keyId,
        userId: authUser.userId,
        keyHash,
        name: validated.name || null,
        createdAt: new Date(),
      })
      .returning();
  });

  if (!createdKey[0]) {
    throw new Error("Failed to create API key");
  }

  logger.info(
    "API key created",
    { userId: authUser.userId, keyId: createdKey[0].id },
    "API Keys",
  );

  // Return full key only once (on creation)
  return successResponse({
    id: createdKey[0].id,
    apiKey, // Only returned on creation, never again!
    name: createdKey[0].name,
    createdAt: createdKey[0].createdAt.toISOString(),
    message:
      "API key created successfully. Save this key - it will not be shown again.",
  });
});
