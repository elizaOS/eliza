import { redirect } from 'next/navigation';

export default async function PredictionMarketRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id?: string | string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  const idParam = resolvedParams.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const query = new URLSearchParams();
  query.set('filter', 'prediction');
  query.set('marketKind', 'prediction');
  if (id) query.set('marketId', id);

  const side = resolvedSearchParams.side;
  const sideValue = Array.isArray(side) ? side[0] : side;
  if (sideValue === 'yes' || sideValue === 'no') {
    query.set('side', sideValue);
  }

  redirect(`/markets?${query.toString()}`);
}
