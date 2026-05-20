import * as api from '@feed/api';
import { TransferTradingBalanceSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const POST = api.withErrorHandling(async (request: NextRequest) => {
  const authUser = await api.authenticate(request);

  const rateLimit = await api.checkRateLimitAsync(
    authUser.dbUserId ?? authUser.userId,
    api.RATE_LIMIT_CONFIGS.A2A_TRANSFER_OPS
  );
  if (!rateLimit.allowed) {
    return api.rateLimitError(rateLimit.retryAfter);
  }

  const body = await request.json();
  const { recipientUserId, amount, description } =
    TransferTradingBalanceSchema.parse(body);

  const result = await api.TradingBalanceTransferService.transfer({
    senderUserId: authUser.dbUserId ?? authUser.userId,
    recipientIdentifier: recipientUserId,
    amount,
    note: description,
  });

  if (!result.success) {
    throw new api.BusinessLogicError(result.error, result.errorCode);
  }

  api.logger.info(
    'Trading balance transfer completed via API route',
    {
      transferId: result.transferId,
      senderUserId: result.senderUserId,
      recipientUserId: result.recipientUserId,
      amount: result.amount,
    },
    'POST /api/users/trading-balance/transfer'
  );

  return api.successResponse({
    transfer: {
      id: result.transferId,
      amount: result.amount.toString(),
      senderUserId: result.senderUserId,
      recipientUserId: result.recipientUserId,
    },
    sender: {
      id: result.senderUserId,
      balanceBefore: result.senderBalanceBefore.toString(),
      balanceAfter: result.senderBalanceAfter.toString(),
    },
    recipient: {
      id: result.recipientUserId,
      balanceBefore: result.recipientBalanceBefore.toString(),
      balanceAfter: result.recipientBalanceAfter.toString(),
    },
  });
});
