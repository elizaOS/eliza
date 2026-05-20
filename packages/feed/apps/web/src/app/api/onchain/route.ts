import { withErrorHandling } from '@babylon/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

type OnchainDisabledResponse = {
  error: string;
  success: false;
};

export const POST = withErrorHandling(
  async (
    _request: NextRequest
  ): Promise<NextResponse<OnchainDisabledResponse>> =>
    NextResponse.json(
      {
        error: 'On-chain actions are no longer supported in this deployment.',
        success: false,
      },
      { status: 410 }
    )
);
