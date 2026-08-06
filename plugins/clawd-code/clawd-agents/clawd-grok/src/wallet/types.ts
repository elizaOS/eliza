import type { PaymentChain } from "../utils/settings";

export interface WalletData {
  address: string;
  chain: PaymentChain;
  createdAt: string;
}

export interface WalletBalance {
  address: string;
  chain: PaymentChain;
  nativeSymbol: string;
  nativeBalance: string;
  usdcBalance: string;
}
