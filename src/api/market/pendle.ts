import { z } from "zod";

/*
 EXAMPLE pendle /markets/active response:
{
  "markets": [
    {
      "name": "crvUSD",
      "address": "0x386f90eb964a477498b528a39d9405e73ed4032b",
      "expiry": "2024-03-28T00:00:00.000Z",
      "pt": "1-0xb87511364014c088e30f872efc4a00d7efb843ac",
      "yt": "1-0xed97f94dd94255637a054098604e0201c442a3fd",
      "sy": "1-0xe05082b184a34668cd8a904d85fa815802bbb04c",
      "underlyingAsset": "1-0xb27d1729489d04473631f0afaca3c3a7389ac9f8",
      "details": {
        "liquidity": 1000000,
        "pendleApy": 0.05,
        "impliedApy": 0.05,
        "feeRate": 0.001,
        "yieldRange": {
          "min": 0.01,
          "max": 0.02
        },
        "aggregatedApy": 0.1,
        "maxBoostedApy": 0.1
      },
      "isNew": true,
      "isPrime": true,
      "timestamp": "2025-03-18T00:00:00.000Z"
    },
    {
      "name": "USD0++",
      "address": "0x64506968e80c9ed07bff60c8d9d57474effff2c9",
      "expiry": "2025-01-30T00:00:00.000Z",
      "pt": "1-0x61439b9575278054d69c9176d88fafaf8319e4b7",
      "yt": "1-0x9697e1ef258b847275e1b32f8a57b3a7e2f8ec50",
      "sy": "1-0x52453825c287ddef62d647ce51c0979d27c461f7",
      "underlyingAsset": "1-0x35d8949372d46b7a3d5a56006ae77b215fc69bc0",
      "details": {
        "liquidity": 1000000,
        "pendleApy": 0.05,
        "impliedApy": 0.05,
        "feeRate": 0.001,
        "yieldRange": {
          "min": 0.01,
          "max": 0.02
        },
        "aggregatedApy": 0.1,
        "maxBoostedApy": 0.1
      },
      "isNew": false,
      "isPrime": false,
      "timestamp": "2025-02-18T00:00:00.000Z"
    }
  ]
}
*/

const ActiveMarketsSchema = z.object({
  markets: z.array(
    z.object({
      name: z.string(),
      address: z.string(),
      expiry: z.string(),
      pt: z.string(),
      yt: z.string(),
      sy: z.string(),
      underlyingAsset: z.string(),
      details: z.any().optional(),
      isNew: z.boolean(),
      isPrime: z.boolean(),
      timestamp: z.string(),
    })
  ),
});

export type PendleActiveMarkets = NonNullable<z.infer<typeof ActiveMarketsSchema>["markets"]>;

export const getActiveMarkets = async (chainId: number) => {
  const url = `https://api-v2.pendle.finance/core/v1/sdk/${chainId}/markets/active`;
  const response = await fetch(url);
  const data = await response.json();
  return ActiveMarketsSchema.safeParse(data);
};
