import { z } from "zod";

export interface AgentSettings {
    signers: string[]
    threshold: number
    converterAddress: string
    agentHeader: {
        messageId?: string
        sourceAgentId?: string
        sourceAgentName: string
        targetAgentId: string
        timestamp?: number
        messageType: number
        priority: number
        ttl: number
    }
}

export const AgentSettingsSchema = z.object({
    signers: z.array(z.string()),
    threshold: z.number(),
    converterAddress: z.string(),
    agentHeader: z.object({
        messageId: z.string().nullish(),
        sourceAgentId: z.string().nullish(),
        sourceAgentName: z.string(),
        targetAgentId: z.string(),
        timestamp: z.number().nullish(),
        messageType: z.number(),
        priority: z.number(),
        ttl: z.number(),
    }),
});

export const isAgentSettings = (value: any): value is AgentSettings => {
    if (AgentSettingsSchema.safeParse(value).success) {
        return true;
    }
    return false;
}

interface Signature {
    r: string
    s: string
    v: 1 | 0 | 27 | 28
  }

interface MessagePayload {
    data: string
    dataHash?: string
    signatures: Signature[]
    metadata?: Metadata
  }

export interface VerifyParams {
    agent: string
    digest: string
    payload: MessagePayload
}

export const VerifyParamsSchema = z.object({
    agent: z.string(),
    digest: z.string(),
    payload: z.object({
        data: z.string(),
        dataHash: z.string().nullish(),
        signatures: z.array(z.object({
            r: z.string(),
            s: z.string(),
            v: z.number(),
        })),
        metadata: z.object({
            contentType: z.string().nullish(),
            encoding: z.string().nullish(),
            compression: z.string().nullish(),
        }).nullish(),
    }),
});

export const isVerifyParams = (value: any): value is VerifyParams => {
    if (VerifyParamsSchema.safeParse(value).success) {
        return true;
    }
    return false;
}

export interface PriceQueryParams {
    pair: string
}

export const PriceQueryParamsSchema = z.object({
    pair: z.string(),
});

export const isPriceQueryParams = (value: any): value is PriceQueryParams => {
    if (PriceQueryParamsSchema.safeParse(value).success) {
        return true;
    }
    return false;
}

export interface PriceData {
    feedId: string
    pair: string
    networks: string[]
    bidPrice: string
    askPrice: string
    midPrice: string
    bidPriceChange: number
    askPriceChange: number
    midPriceChange: number
    timestamp: number
}

export const AttpsPriceQuerySchema = z.object({
    sourceAgentId: z.string(),
    feedId: z.string(),
});

export const isAttpsPriceQuery = (value: any): value is AttpsPriceQuery => {
    if (AttpsPriceQuerySchema.safeParse(value).success) {
        return true;
    }
    return false;
}

export interface AttpsPriceQuery {
    sourceAgentId: string
    feedId: string
}

export interface AttpsPriceQueryResponse {
    feedId: string
    validTimeStamp: number
    observeTimeStamp: number
    nativeFee: number
    tokenFee: number
    expireTimeStamp: number
    midPrice: string
    askPrice: string
    bidPrice: string
}