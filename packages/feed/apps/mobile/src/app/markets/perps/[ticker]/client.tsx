'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export function MobilePerpsMarketRedirect() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  useEffect(() => {
    const ticker = params.ticker as string | undefined;
    const query = new URLSearchParams();
    query.set('filter', 'perp');
    query.set('marketKind', 'perp');
    if (ticker) query.set('marketId', ticker);

    const side = searchParams.get('side');
    if (side === 'long' || side === 'short') {
      query.set('side', side);
    }

    router.replace(`/markets?${query.toString()}`);
  }, [router, params.ticker, searchParams]);

  return null;
}
