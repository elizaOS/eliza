import { Address } from "viem";

type ERC20 = {
    name: string;
    symbol: string;
    decimals: number;
    address?: Address;
};

export type { ERC20 };
