import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Loader from './loader.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { cn } from './utils.js';

const formatUSD = (value: number): string => {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;

  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 1 ? 2 : 2,
    maximumFractionDigits: value >= 1 ? 2 : 10,
  };

  return new Intl.NumberFormat('en-US', options).format(value);
};

const formatNumber = (value: number): string => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
};

export default function Trending() {
  const [selectedChain, setSelectedChain] = useState<'all' | 'solana' | 'base' | 'ethereum'>('all');

  const query = useQuery({
    queryKey: ['trending'],
    queryFn: async () => {
      const response = await fetch('/api/intel/trending', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : { solana: [], base: [], ethereum: [] };
    },
    refetchInterval: 5_000,
  });

  const logos = {
    ethereum: '/logos/ethereum.png',
    base: '/logos/base.jpeg',
    solana: '/logos/solana.png',
    birdeye: '/logos/birdeye.png',
    coinmarketcap: '/logos/coinmarketcap.png',
    L1: '/logos/l1.png',
  };

  if (query?.isPending) {
    return <Loader />;
  }

  const data = query?.data || {};
  const allTokens = [
    ...(data.solana || []).map((t) => ({ ...t, chain: 'solana' })),
    ...(data.base || []).map((t) => ({ ...t, chain: 'base' })),
    ...(data.ethereum || []).map((t) => ({ ...t, chain: 'ethereum' })),
  ];

  const filteredTokens =
    selectedChain === 'all'
      ? allTokens
      : allTokens.filter((token) => token.chain === selectedChain);

  const sortedTokens = filteredTokens.sort((a, b) => (a.rank || 999) - (b.rank || 999));

  // Calculate stats
  const totalTokens = allTokens.length;
  const avgChange =
    allTokens.length > 0
      ? allTokens.reduce((sum, token) => sum + (token.price24hChangePercent || 0), 0) /
        allTokens.length
      : 0;
  const gainers = allTokens.filter((t) => (t.price24hChangePercent || 0) > 0).length;
  const losers = allTokens.filter((t) => (t.price24hChangePercent || 0) < 0).length;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTokens}</div>
            <p className="text-xs text-muted-foreground">Across all chains</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg 24h Change</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${avgChange >= 0 ? 'text-green-600' : 'text-red-600'}`}
            >
              {avgChange >= 0 ? '+' : ''}
              {avgChange.toFixed(2)}%
            </div>
            <p className="text-xs text-muted-foreground">Market sentiment</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Gainers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{gainers}</div>
            <p className="text-xs text-muted-foreground">
              {totalTokens > 0 ? ((gainers / totalTokens) * 100).toFixed(1) : 0}% positive
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Losers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{losers}</div>
            <p className="text-xs text-muted-foreground">
              {totalTokens > 0 ? ((losers / totalTokens) * 100).toFixed(1) : 0}% negative
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Chain Filter */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Trending Tokens
            <div className="flex gap-2">
              {['all', 'solana', 'base', 'ethereum'].map((chain) => (
                <Button
                  key={chain}
                  variant={selectedChain === chain ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedChain(chain as any)}
                  className="capitalize"
                >
                  {chain === 'all' ? 'All Chains' : chain}
                  {chain !== 'all' && (
                    <Badge variant="secondary" className="ml-2">
                      {data[chain]?.length || 0}
                    </Badge>
                  )}
                </Button>
              ))}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]">Rank</TableHead>
                <TableHead className="w-[50px]">Chain</TableHead>
                <TableHead className="w-[300px]">Token</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">24h Change</TableHead>
                <TableHead className="text-right">Volume 24h</TableHead>
                <TableHead className="text-right">Market Cap</TableHead>
                <TableHead className="text-right">Liquidity</TableHead>
                <TableHead className="text-center">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTokens.map((item, index) => (
                <TableRow key={`${item._id || item.address || index}_${item.price}`}>
                  <TableCell className="font-medium">
                    <Badge variant="outline">#{item.rank || index + 1}</Badge>
                  </TableCell>
                  <TableCell>
                    <img
                      src={logos[item.chain]}
                      height="24"
                      width="24"
                      className="object-contain rounded-md"
                      alt={item.chain}
                      title={item.chain}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {item?.logoURI ? (
                        <img
                          src={item.logoURI}
                          height="32"
                          width="32"
                          className="object-contain rounded-full"
                          alt="logo"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-muted grid place-items-center text-sm font-medium">
                          {item?.symbol?.[0]}
                        </div>
                      )}
                      <div>
                        <div className="font-semibold">{item.name}</div>
                        <div className="text-sm text-muted-foreground">{item.symbol}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatUSD(item.price)}</TableCell>
                  <TableCell className="text-right">
                    {item?.price24hChangePercent !== undefined ? (
                      <Badge
                        variant={item.price24hChangePercent >= 0 ? 'default' : 'destructive'}
                        className={cn(
                          item.price24hChangePercent >= 0
                            ? 'bg-green-100 text-green-800 hover:bg-green-100'
                            : 'bg-red-100 text-red-800 hover:bg-red-100'
                        )}
                      >
                        {item.price24hChangePercent >= 0 ? '+' : ''}
                        {item.price24hChangePercent.toFixed(2)}%
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.volume24hUSD ? formatUSD(item.volume24hUSD) : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.marketcap ? formatUSD(item.marketcap) : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {item?.liquidity ? formatUSD(item.liquidity) : '-'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-center gap-1">
                      {[
                        {
                          provider: 'birdeye',
                          href: `https://www.birdeye.so/token/${item.address}?chain=${item.chain}`,
                          disabled: item.chain === 'L1',
                        },
                        {
                          provider: 'solana',
                          href: `https://solscan.io/token/${item.address}`,
                          disabled: item.chain !== 'solana',
                        },
                        {
                          provider: 'base',
                          href: `https://basescan.org/address/${item.address}`,
                          disabled: item.chain !== 'base',
                        },
                      ].map((linkItem, linkIndex) => (
                        <a
                          href={linkItem?.disabled ? '#' : linkItem.href}
                          target="_blank"
                          key={linkIndex}
                          rel="noreferrer"
                          aria-disabled={linkItem.disabled}
                          className={cn([
                            'rounded-md p-1 hover:bg-muted transition-colors',
                            linkItem?.disabled
                              ? 'opacity-30 cursor-not-allowed'
                              : 'opacity-70 hover:opacity-100',
                          ])}
                        >
                          <img
                            src={logos[linkItem.provider]}
                            height="16"
                            width="16"
                            className="object-contain"
                            alt="logo"
                          />
                        </a>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {sortedTokens.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No trending tokens available</p>
              <p className="text-sm text-muted-foreground mt-2">
                Token data will appear here once the data sources are active
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
