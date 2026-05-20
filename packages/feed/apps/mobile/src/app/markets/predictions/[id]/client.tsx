'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export function MobilePredictionMarketRedirect() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  useEffect(() => {
    const id = params.id as string | undefined;
    const query = new URLSearchParams();
    query.set('filter', 'prediction');
    query.set('marketKind', 'prediction');
    if (id) query.set('marketId', id);

    const side = searchParams.get('side');
    if (side === 'yes' || side === 'no') {
      query.set('side', side);
    }

    router.replace(`/markets?${query.toString()}`);
  }, [router, params.id, searchParams]);

  return null;
}
