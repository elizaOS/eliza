import {z} from "zod";

export const IBCSwapParamsSchema = z.object({
    fromChainName: z.string().min(1),
    fromTokenSymbol: z.string().regex(/^[A-Z0-9]+$/),
    fromTokenAmount: z.string().regex(/^\d+$/),
    toTokenSymbol: z.string().regex(/^[A-Z0-9]+$/),
    toChainName: z.string().min(1),
    toTokenDenom: z.string().regex(/^ibc\/[A-F0-9]{64}$/),
    fromTokenDenom: z.string().regex(/^ibc\/[A-F0-9]{64}$/),
});
