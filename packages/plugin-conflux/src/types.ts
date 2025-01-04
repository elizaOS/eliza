import { z } from "zod";
import { Content } from "@elizaos/core";

export const TransferSchema = z.object({
    to: z.string(),
    amount: z.number(), // use number ignoring decimals issue
});

export interface TransferContent {
    to: string;
    amount: number;
}

export const isTransferContent = (object: any): object is TransferContent => {
    if (TransferSchema.safeParse(object).success) {
        return true;
    }
    console.error("Invalid content: ", object);
    return false;
};

export const PumpCreateSchema = z.object({
    action: z.literal("CREATE_TOKEN"),
    params: z.object({
        symbol: z.string(),
        name: z.string(),
        description: z.string(),
    }),
});

export const PumpBuySchema = z.object({
    action: z.literal("BUY_TOKEN"),
    params: z.object({
        tokenAddress: z.string(),
        value: z.number(),
    }),
});

export const PumpSellSchema = z.object({
    action: z.literal("SELL_TOKEN"),
    params: z.object({
        tokenAddress: z.string(),
        value: z.number(),
    }),
});

export const PumpSchema = z.union([
    PumpCreateSchema,
    PumpBuySchema,
    PumpSellSchema,
]);

export type PumpContent = z.infer<typeof PumpSchema>;
export type PumpCreateContent = z.infer<typeof PumpCreateSchema>;
export type PumpBuyContent = z.infer<typeof PumpBuySchema>;
export type PumpSellContent = z.infer<typeof PumpSellSchema>;

export function isPumpContent(object: any): object is PumpContent {
    if (PumpSchema.safeParse(object).success) {
        return true;
    }
    console.error("Invalid content: ", object);
    return false;
}

export function isPumpCreateContent(object: any): object is PumpCreateContent {
    return PumpCreateSchema.safeParse(object).success;
}

export function isPumpBuyContent(object: any): object is PumpBuyContent {
    return PumpBuySchema.safeParse(object).success;
}

export function isPumpSellContent(object: any): object is PumpSellContent {
    return PumpSellSchema.safeParse(object).success;
}
