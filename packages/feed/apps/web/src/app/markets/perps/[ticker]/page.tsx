import { redirect } from 'next/navigation';

export default async function PerpsMarketRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticker?: string | string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  const tickerParam = resolvedParams.ticker;
  const ticker = Array.isArray(tickerParam) ? tickerParam[0] : tickerParam;

  const query = new URLSearchParams();
  query.set('filter', 'perp');
  query.set('marketKind', 'perp');
  if (ticker) query.set('marketId', ticker);

  const side = resolvedSearchParams.side;
  const sideValue = Array.isArray(side) ? side[0] : side;
  if (sideValue === 'long' || sideValue === 'short') {
    query.set('side', sideValue);
  }

  redirect(`/markets?${query.toString()}`);
}
