import {
  authenticateWithDbUser,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { ensureNftChatMembership } from '@babylon/api/services/nft-chat-gating-service';
import type { NextRequest } from 'next/server';

/**
 * POST /api/nft/chat/ensure
 *
 * Ensures the authenticated user is a member of the configured NFT-gated chat.
 * This is used after minting to grant access to the private chat experience.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticateWithDbUser(request);
  return successResponse(await ensureNftChatMembership(user.dbUserId));
});
