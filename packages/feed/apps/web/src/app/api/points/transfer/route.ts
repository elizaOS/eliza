import { withErrorHandling } from '@babylon/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const TRANSFER_POINTS_DISABLED_ERROR =
  'Point transfers are no longer supported. Babylon now separates Trading Balance from non-transferable Reputation.';

export const POST = withErrorHandling(async (_request: NextRequest) => {
  return NextResponse.json(
    {
      error: TRANSFER_POINTS_DISABLED_ERROR,
      code: 'TRANSFER_POINTS_DISABLED',
    },
    { status: 410 }
  );
});
