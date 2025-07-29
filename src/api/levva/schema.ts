import { z } from "zod";

const tokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number(),
  priceUsd: z.number(),
  protocol: z.any().optional(),
  bonuses: z.array(z.any()).optional(),
});

export const strategiesResponseSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    shortDescription: z.string(),
    backgroundColor: z.string().nullable(),
    type: z.string(),
    category: z.string(),
    risk: z.string(),
    minimumEfficientDeposit: z.number(),
    liquidityAvailability: z.string(),
    vault: z
      .object({
        id: z.number(),
        publicChainId: z.number(),
        address: z.string(),
        name: z.string().nullable(),
        underlyingToken: tokenSchema,
        lpToken: tokenSchema,
        lpTotalSupply: z.number(),
        performanceFee: z.number(),
        managementFee: z.number(),
        totalAssets: z.number(),
        currentApy: z.number(),
        minDeposit: z.number(),
        createdAt: z.string(),
      })
      .optional(),
  })
);

export type StrategiesResponse = z.infer<typeof strategiesResponseSchema>;