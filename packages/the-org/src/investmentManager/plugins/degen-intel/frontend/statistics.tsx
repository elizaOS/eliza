import { useQuery } from '@tanstack/react-query';

export default function Statistics() {
  const query = useQuery({
    queryKey: ['statistics'],
    queryFn: async () => {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/statistics`, {
        method: 'POST',
      });
      const data = await response.json();
      return data;
    },
    refetchInterval: 5_000,
  });

  return (
    <div className="py-4 w-full bg-muted">
      <div className="container flex items-center gap-4">
        {query?.isPending ? (
          <div className="text-sm animate-pulse">Loading</div>
        ) : (
          <div className="flex items-center gap-4 text-sm">
            <span>📚 Tweets {query?.data?.tweets}</span>
            <span className="text-muted">•</span>
            <span>🌍 Sentiment {query?.data?.sentiment}</span>
            <span>•</span>
            <span>💸 Tokens {query?.data?.tokens}</span>
            <span>•</span>
            <span>⛓️ Chains 3</span>
          </div>
        )}
      </div>
    </div>
  );
}
