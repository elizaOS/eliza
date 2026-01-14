import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Wallet as WalletIcon, Search, Filter } from 'lucide-react';
import Loader from './loader.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Input } from './ui/input.js';

const formatCurrency = (value: number, minimumFractionDigits = 2, maximumFractionDigits = 2) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
};

const formatNumber = (value: number, maximumFractionDigits = 6) => {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value);
};

export default function Wallet() {
  const [searchTerm, setSearchTerm] = useState('');
  const [showSmallBalances, setShowSmallBalances] = useState(false);
  const [sortBy, setSortBy] = useState<'value' | 'balance' | 'name'>('value');

  const query = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => {
      const response = await fetch('/api/intel/portfolio', {
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

  const portfolio = query?.data?.data || query?.data;

  if (!portfolio || !portfolio.items) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="text-center py-8">
            <WalletIcon className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">No portfolio data available</p>
            <p className="text-sm text-muted-foreground mt-2">
              Portfolio data will appear here once the Solana service is connected
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Filter and sort tokens
  const filteredTokens = portfolio.items
    .filter((asset) => {
      const valueUsd = Number(asset?.valueUsd) || 0;
      const matchesSearch =
        !searchTerm ||
        asset.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        asset.symbol?.toLowerCase().includes(searchTerm.toLowerCase());
      const meetsValueThreshold = showSmallBalances || valueUsd > 1;
      return matchesSearch && meetsValueThreshold;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'value':
          return (Number(b.valueUsd) || 0) - (Number(a.valueUsd) || 0);
        case 'balance':
          return (
            (Number(b.uiAmount) || Number(b.balance) || 0) -
            (Number(a.uiAmount) || Number(a.balance) || 0)
          );
        case 'name':
          return (a.name || a.symbol || '').localeCompare(b.name || b.symbol || '');
        default:
          return 0;
      }
    });

  // Calculate stats
  const totalValue = Number(portfolio.totalUsd) || 0;
  const totalTokens = portfolio.items.length;
  const significantTokens = portfolio.items.filter(
    (asset) => (Number(asset?.valueUsd) || 0) > 50
  ).length;
  const smallTokens = portfolio.items.filter((asset) => (Number(asset?.valueUsd) || 0) <= 1).length;

  return (
    <div className="space-y-6">
      {/* Portfolio Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
            <p className="text-xs text-muted-foreground">Portfolio value</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTokens}</div>
            <p className="text-xs text-muted-foreground">Unique assets</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Significant Holdings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{significantTokens}</div>
            <p className="text-xs text-muted-foreground">Value &gt; $50</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Small Holdings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{smallTokens}</div>
            <p className="text-xs text-muted-foreground">Value ≤ $1</p>
          </CardContent>
        </Card>
      </div>

      {/* Wallet Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WalletIcon className="h-5 w-5" />
            Wallet Address
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <code className="text-sm font-mono">{portfolio.wallet || 'Unknown'}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (portfolio.wallet) {
                  window.open(`https://solscan.io/account/${portfolio.wallet}`, '_blank');
                }
              }}
            >
              View on Solscan
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Token Holdings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>Token Holdings</span>
              <Badge variant="secondary">{filteredTokens.length}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tokens..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 w-48"
                />
              </div>

              {/* Filters */}
              <Button
                variant={showSmallBalances ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowSmallBalances(!showSmallBalances)}
              >
                <Filter className="h-4 w-4 mr-1" />
                Small Balances
              </Button>

              {/* Sort Options */}
              <div className="flex gap-1">
                {[
                  { key: 'value', label: 'Value' },
                  { key: 'balance', label: 'Balance' },
                  { key: 'name', label: 'Name' },
                ].map((option) => (
                  <Button
                    key={option.key}
                    variant={sortBy === option.key ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSortBy(option.key as any)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredTokens.map((asset, idx: number) => {
              const valueUsd = Number(asset?.valueUsd) || 0;
              const balance = Number(asset.uiAmount) || Number(asset.balance) || 0;
              const price = Number(asset.priceUsd) || 0;

              return (
                <Card
                  key={`${asset.address || asset.symbol}-${idx}`}
                  className={`overflow-hidden hover:shadow-lg transition-all duration-300 ${
                    valueUsd > 100
                      ? 'ring-2 ring-green-200'
                      : valueUsd > 10
                        ? 'ring-1 ring-yellow-200'
                        : ''
                  }`}
                >
                  <CardContent className="p-4">
                    {/* Token Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        {asset.logoURI ? (
                          <img
                            src={asset.logoURI}
                            alt={asset?.name}
                            width={32}
                            height={32}
                            className="rounded-full"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 grid place-items-center text-white text-sm font-bold">
                            {asset?.symbol?.[0] || '?'}
                          </div>
                        )}
                        <div>
                          <h3 className="font-semibold text-sm truncate max-w-[120px]">
                            {asset.name || asset.symbol}
                          </h3>
                          <p className="text-xs text-muted-foreground">{asset.symbol}</p>
                        </div>
                      </div>
                      {valueUsd > 100 && (
                        <Badge variant="default" className="bg-green-100 text-green-800">
                          Major
                        </Badge>
                      )}
                      {valueUsd > 10 && valueUsd <= 100 && (
                        <Badge variant="secondary">Medium</Badge>
                      )}
                      {valueUsd <= 10 && valueUsd > 1 && <Badge variant="outline">Small</Badge>}
                      {valueUsd <= 1 && (
                        <Badge variant="outline" className="text-muted-foreground">
                          Dust
                        </Badge>
                      )}
                    </div>

                    {/* Value Display */}
                    <div className="space-y-2">
                      <div>
                        <p className="text-lg font-bold">{formatCurrency(valueUsd)}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatNumber(balance)} {asset.symbol}
                        </p>
                      </div>

                      {price > 0 && (
                        <div className="pt-2 border-t border-muted">
                          <p className="text-xs text-muted-foreground">
                            Price:{' '}
                            <span className="font-medium">{formatCurrency(price, 6, 6)}</span>
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Action Buttons */}
                    {asset.address && (
                      <div className="flex gap-1 mt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 text-xs"
                          onClick={() => {
                            window.open(
                              `https://www.birdeye.so/token/${asset.address}?chain=solana`,
                              '_blank'
                            );
                          }}
                        >
                          Birdeye
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 text-xs"
                          onClick={() => {
                            window.open(`https://solscan.io/token/${asset.address}`, '_blank');
                          }}
                        >
                          Solscan
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {filteredTokens.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {searchTerm ? 'No tokens match your search' : 'No tokens found'}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                {searchTerm
                  ? 'Try adjusting your search terms or filters'
                  : showSmallBalances
                    ? 'Try enabling small balances filter'
                    : 'Portfolio tokens will appear here'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
