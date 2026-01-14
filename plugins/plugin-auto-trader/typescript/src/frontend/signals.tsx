import { useQuery } from '@tanstack/react-query';
import moment from 'moment';
import { TrendingUp, TrendingDown, AlertCircle, CheckCircle } from 'lucide-react';
import Loader from './loader.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Button } from './ui/button.js';

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
};

export default function Signals() {
  const query = useQuery({
    queryKey: ['signals'],
    queryFn: async () => {
      const response = await fetch('/api/intel/signals', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : { buy: null, sell: null };
    },
    refetchInterval: 5_000,
  });

  const summaryQuery = useQuery({
    queryKey: ['signals-summary'],
    queryFn: async () => {
      const response = await fetch('/api/intel/summary', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : null;
    },
    refetchInterval: 5_000,
  });

  if (query?.isPending) {
    return <Loader />;
  }

  const { buy, sell } = query?.data || {};
  const summary = summaryQuery?.data?.summary;

  const SignalCard = ({ signal, type, icon: Icon, borderColor, badgeVariant, bgColor }) => (
    <Card className={`${borderColor} ${signal ? bgColor : 'bg-card'} transition-all duration-300`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5" />
            {type} Signal
          </div>
          {signal ? (
            <Badge variant={badgeVariant} className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3" />
              Active
            </Badge>
          ) : (
            <Badge variant="secondary" className="flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              None
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {signal ? (
          <div className="space-y-4">
            {/* Token Info */}
            <div className="p-4 rounded-lg bg-background/50 border">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xl font-bold">
                  {signal.recommended_buy || signal.recommended_sell}
                </h3>
                <Badge variant="outline" className="font-mono text-xs">
                  {type === 'Buy' ? signal.buy_amount : signal.sell_amount}
                  {type === 'Buy' ? ' SOL' : ''}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground font-mono break-all">
                {signal.recommend_buy_address || signal.recommend_sell_address}
              </p>
            </div>

            {/* Signal Details */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Market Cap</p>
                <p className="text-lg font-semibold">
                  {signal.marketcap ? formatCurrency(signal.marketcap) : 'N/A'}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Generated</p>
                <p className="text-sm">
                  {signal.timestamp ? moment(signal.timestamp).fromNow() : 'Recently'}
                </p>
              </div>
            </div>

            {/* Reasoning */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">AI Analysis</p>
              <div className="p-3 rounded-lg bg-background/50 border">
                <p className="text-sm leading-relaxed">{signal.reason}</p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const address = signal.recommend_buy_address || signal.recommend_sell_address;
                  if (address) {
                    window.open(`https://www.birdeye.so/token/${address}?chain=solana`, '_blank');
                  }
                }}
              >
                View on Birdeye
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const address = signal.recommend_buy_address || signal.recommend_sell_address;
                  if (address) {
                    window.open(`https://solscan.io/token/${address}`, '_blank');
                  }
                }}
              >
                View on Solscan
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center py-8">
            <Icon className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">No active {type.toLowerCase()} signal</p>
            <p className="text-sm text-muted-foreground mt-2">
              AI will generate signals based on market sentiment and trends
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Signal Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(buy ? 1 : 0) + (sell ? 1 : 0)}/2</div>
            <p className="text-xs text-muted-foreground">Active signals</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Buy Signal</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${buy ? 'text-green-600' : 'text-muted-foreground'}`}
            >
              {buy ? '✅' : '❌'}
            </div>
            <p className="text-xs text-muted-foreground">{buy ? 'Active' : 'Inactive'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Sell Signal</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${sell ? 'text-red-600' : 'text-muted-foreground'}`}
            >
              {sell ? '✅' : '❌'}
            </div>
            <p className="text-xs text-muted-foreground">{sell ? 'Active' : 'Inactive'}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Portfolio Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.portfolioValue || '$0'}</div>
            <p className="text-xs text-muted-foreground">Current holdings</p>
          </CardContent>
        </Card>
      </div>

      {/* Signal Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SignalCard
          signal={buy}
          type="Buy"
          icon={TrendingUp}
          borderColor="border-green-200"
          badgeVariant="default"
          bgColor="bg-green-50/50"
        />

        <SignalCard
          signal={sell}
          type="Sell"
          icon={TrendingDown}
          borderColor="border-red-200"
          badgeVariant="destructive"
          bgColor="bg-red-50/50"
        />
      </div>

      {/* Signal Information */}
      <Card>
        <CardHeader>
          <CardTitle>How Signals Work</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold text-green-600 mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Buy Signals
              </h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Generated when positive sentiment is detected</li>
                <li>• Considers trending tokens and volume</li>
                <li>• Analyzes market cap and liquidity</li>
                <li>• Includes AI reasoning for the recommendation</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-red-600 mb-2 flex items-center gap-2">
                <TrendingDown className="h-4 w-4" />
                Sell Signals
              </h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Triggered by negative sentiment analysis</li>
                <li>• Monitors portfolio token performance</li>
                <li>• Considers market conditions and trends</li>
                <li>• Suggests optimal sell amounts</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
