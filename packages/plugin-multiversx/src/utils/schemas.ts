import { z } from "zod";

export const createTokenSchema = z.object({
    tokenName: z.string().min(1, { message: "Token name is required." }),
    tokenTicker: z.string().min(1, { message: "Token ticker is required." }),
    amount: z
        .number()
        .positive({ message: "Amount must be a positive number." }),
    decimals: z
        .number()
        .int()
        .min(0, { message: "Decimals must be at least 0" })
        .max(18, { message: "Decimals must be at most 18" })
        .nullable()
        .optional(),
});

export const transferSchema = z.object({
    tokenAddress: z.string().min(1, { message: "Token address is required." }),
    amount: z.string().min(1, { message: "Amount is required." }),
    tokenIdentifier: z
        .string()
        .transform((val) => (val === "null" ? null : val))
        .nullable()
        .optional(),
});

export const swapSchema = z.object({
    tokenIn: z.string().min(1, { message: "First token is required." }),
    amountIn: z.string().min(1, { message: "Amount is required." }),
    tokenOut: z.string().min(1, { message: "Second token is required." }),
});
