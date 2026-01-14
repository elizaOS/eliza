import { useQuery } from '@tanstack/react-query';
import moment from 'moment';
import Loader from './loader.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

const getSentimentColor = (sentiment: number) => {
  if (sentiment >= 75) return 'text-green-600 bg-green-50';
  if (sentiment >= 25) return 'text-green-500 bg-green-50';
  if (sentiment >= -25) return 'text-yellow-600 bg-yellow-50';
  if (sentiment >= -75) return 'text-red-500 bg-red-50';
  return 'text-red-600 bg-red-50';
};

const getSentimentLabel = (sentiment: number) => {
  if (sentiment >= 75) return 'Very Bullish';
  if (sentiment >= 25) return 'Bullish';
  if (sentiment >= -25) return 'Neutral';
  if (sentiment >= -75) return 'Bearish';
  return 'Very Bearish';
};

export default function Sentiment() {
  const query = useQuery({
    queryKey: ['sentiment'],
    queryFn: async () => {
      const response = await fetch('/api/intel/sentiment', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : [];
    },
    refetchInterval: 5_000,
  });

  if (query?.isPending) {
    return <Loader />;
  }

  const sentiments = query?.data || [];
  const recentSentiments = sentiments.slice(0, 10);

  // Calculate overall sentiment stats
  const allTokens = sentiments.flatMap((s) => s.occuringTokens || []);
  const avgSentiment =
    allTokens.length > 0
      ? allTokens.reduce((sum, token) => sum + token.sentiment, 0) / allTokens.length
      : 0;

  const bullishCount = allTokens.filter((t) => t.sentiment > 25).length;
  const bearishCount = allTokens.filter((t) => t.sentiment < -25).length;
  const neutralCount = allTokens.filter((t) => t.sentiment >= -25 && t.sentiment <= 25).length;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Overall Sentiment</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgSentiment.toFixed(1)}</div>
            <p className="text-xs text-muted-foreground">{getSentimentLabel(avgSentiment)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Bullish Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{bullishCount}</div>
            <p className="text-xs text-muted-foreground">
              {allTokens.length > 0 ? ((bullishCount / allTokens.length) * 100).toFixed(1) : 0}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Bearish Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{bearishCount}</div>
            <p className="text-xs text-muted-foreground">
              {allTokens.length > 0 ? ((bearishCount / allTokens.length) * 100).toFixed(1) : 0}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Analysis</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sentiments.length}</div>
            <p className="text-xs text-muted-foreground">{allTokens.length} tokens analyzed</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Sentiment Analysis */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sentiment Analysis</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Timestamp</TableHead>
                <TableHead className="w-[400px]">Summary</TableHead>
                <TableHead>Token Sentiment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentSentiments.map((item, index) => (
                <TableRow key={item._id || index}>
                  <TableCell className="font-medium text-muted-foreground">
                    {moment(item.timeslot).format('MMM DD, HH:mm')}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-md">
                      <p className="text-sm">{item.text}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {item.occuringTokens?.map((token, tokenIndex) => (
                        <div
                          key={`${item.timeslot}-${token.token}-${tokenIndex}`}
                          className="flex items-center gap-2 p-2 rounded-lg border bg-card"
                        >
                          <div className="font-medium text-sm">{token.token}</div>
                          <Badge
                            className={`${getSentimentColor(token.sentiment)} border-0`}
                            variant="secondary"
                          >
                            {token.sentiment > 0 ? '+' : ''}
                            {token.sentiment}
                          </Badge>
                          <div className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {token.reason}
                          </div>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {sentiments.length === 0 && (
        <Card>
          <CardContent className="text-center py-8">
            <p className="text-muted-foreground">No sentiment data available</p>
            <p className="text-sm text-muted-foreground mt-2">
              Sentiment analysis will appear here once Twitter data is processed
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
