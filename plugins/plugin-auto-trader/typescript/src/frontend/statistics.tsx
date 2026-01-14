import { useQuery } from '@tanstack/react-query';

export default function Statistics() {
  const query = useQuery({
    queryKey: ['statistics'],
    queryFn: async () => {
      const response = await fetch('/api/intel/summary', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : null;
    },
    refetchInterval: 5_000,
  });

  const summary = query?.data?.summary;

  const formatPortfolioValue = (value: any) => {
    if (!value) return '$0.00';
    const numValue = typeof value === 'string' ? parseFloat(value.replace('$', '')) : Number(value);
    return `$${numValue.toFixed(2)}`;
  };

  return (
    <div className="py-4 w-full bg-muted">
      <div className="container flex items-center gap-4">
        {query?.isPending ? (
          <div className="text-sm animate-pulse">Loading</div>
        ) : (
          <div className="flex items-center gap-4 text-sm">
            <span>📚 Tweets {summary?.totalTweets || 0}</span>
            <span className="text-muted">•</span>
            <span>🌍 Sentiment {summary?.averageSentiment?.toFixed(1) || 'N/A'}</span>
            <span>•</span>
            <span>💸 Tokens {summary?.trendingTokensCount || 0}</span>
            <span>•</span>
            <span>💰 Portfolio {formatPortfolioValue(summary?.portfolioValue)}</span>
            <span>•</span>
            <span>📈 Buy? {summary?.hasActiveBuySignal ? '✅' : '❌'}</span>
            <span>•</span>
            <span>📉 Sell? {summary?.hasActiveSellSignal ? '✅' : '❌'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
