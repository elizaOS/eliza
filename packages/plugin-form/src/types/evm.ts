import { Abi } from "abitype";

type Tx = {
    to: string;
    functionName?: string;
    args?: unknown[];
    value?: bigint;
    abi?: Abi;
    options?: TxOpts;
    data?: `0x${string}`;
};

type TxOpts = {
    gasLimit: bigint;
};

type ReadReq = {
    address: string;
    functionName?: string;
    args?: unknown[];
    abi?: Abi;
};

type Receipt = {
    txHash: `0x{string}`;
    status: number;
};

export type { Tx, TxOpts, ReadReq, Receipt };
