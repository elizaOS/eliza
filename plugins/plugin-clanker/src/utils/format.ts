import { formatUnits, parseUnits } from 'ethers';

export function formatTokenAmount(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals);
}

export function parseTokenAmount(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatTransactionHash(hash: string): string {
  return shortenAddress(hash);
}

export function calculatePriceImpact(
  inputAmount: bigint,
  outputAmount: bigint,
  inputPrice: number,
  outputPrice: number
): number {
  const inputValue = Number(inputAmount) * inputPrice;
  const outputValue = Number(outputAmount) * outputPrice;
  
  if (inputValue === 0) return 0;
  
  const impact = (inputValue - outputValue) / inputValue;
  return Math.abs(impact);
}

export function formatTokenInfo(info: any): string {
  const lines = [
    `Token: ${info.name} (${info.symbol})`,
    `Address: ${info.address}`,
  ];

  if (info.price !== undefined) {
    lines.push(`Price: ${formatUsd(info.price)}`);
  }

  if (info.marketCap !== undefined) {
    lines.push(`Market Cap: ${formatCompactUsd(Number(info.marketCap))}`);
  }

  if (info.liquidity !== undefined) {
    lines.push(`Liquidity: ${formatCompactUsd(Number(info.liquidity))}`);
  }

  if (info.holders !== undefined) {
    lines.push(`Holders: ${info.holders.toLocaleString()}`);
  }

  if (info.volume24h !== undefined) {
    lines.push(`24h Volume: ${formatCompactUsd(Number(info.volume24h))}`);
  }

  return lines.join('\n');
}


export function formatBalance(balance: bigint, decimals: number, symbol: string): string {
  const formatted = formatTokenAmount(balance, decimals);
  return `${formatted} ${symbol}`;
}

export function formatGasPrice(gasPrice: bigint): string {
  const gwei = Number(gasPrice) / 1e9;
  return `${gwei.toFixed(2)} gwei`;
}

export function formatCompactUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(amount);
}