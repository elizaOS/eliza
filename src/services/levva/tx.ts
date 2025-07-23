/*
 "method": "swapExactTokenForPt",
  "contractCallParamsName": [
    "receiver",
    "market",
    "minPtOut",
    "guessPtOut",
    "input",
    "limit"
  ],
  "contractCallParams": [
    "0x463e3466f6c332959969a99811a7a95d080fe0b2",
    "0x46d62a8dede1bf2d0de04f2ed863245cbba5e538",
    "27845880897175233",
    {
      "guessMin": "14063576210694562",
      "guessMax": "29533510042458581",
      "guessOffchain": "28127152421389125",
      "maxIteration": "30",
      "eps": "10000000000000"
    },
    {
      "tokenIn": "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      "netTokenIn": "100000000",
      "tokenMintSy": "0x35751007a407ca6feffe80b3cb397736d2cf4dbe",
      "pendleSwap": "0xd4f480965d2347d421f1bec7f545682e5ec2151d",
      "swapData": {
        "swapType": "2",
        "extRouter": "0xa669e7a0d4b3e4fa48af2de86bd4cd7126be4e13",
        "extCalldata": "0x83bd37f90008000135751007a407ca6feffe80b3cb397736d2cf4dbe0405f5e100075ae4f87c92430c00c49b000184fF2DDf2BC84e37Ed3BD2D0192e8534D12574f100000001888888888889758f76e7103c6cbf23abbf58f94635d39ebf06010208004101010200020b0000030400002801000506020b0001070600ff0000e4b2dfc82977dd2dce7e8d37895a6a8f50cbb4fbfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9cda53b1f66614552f834ceef361a8d12a0b8dad8ff970a61a04b1ca14834a43f5de4533ebddb5cc8912ce59144191c1204e64559fe8253a0e49e654882af49447d8a07e3bd95bd0d56f35241523fbab1293dfd996d5cd72bed712b0eeab96dbe400c04160000000000000000000000000000000000000000",
        "needScale": false
      }
    },
    {
      "limitRouter": "0x0000000000000000000000000000000000000000",
      "epsSkipMarket": "0",
      "normalFills": [],
      "flashFills": [],
      "optData": "0x"
    }
  ],
  */

import { encodeFunctionData, isHex } from "viem";
import pendleBundlerAbi from "./abi/pendle.bundler.abi";

interface PendleSwapParams {
  contractCallParamsName: string[];
  contractCallParams: any[];
}

interface BundlerEnterParams {
  pool: `0x${string}`;
  longAmount: bigint;
  limitPriceX96: bigint;
}

interface ExtractedParams {
  market: `0x${string}`;
  minPt: bigint;
  approxParams: {
    guessMin: bigint;
    guessMax: bigint;
    guessOffchain: bigint;
    maxIteration: bigint;
    eps: bigint;
  };
  tokenInput: {
    tokenIn: `0x${string}`;
    netTokenIn: bigint;
    tokenMintSy: `0x${string}`;
    pendleSwap: `0x${string}`;
    swapData: {
      swapType: number;
      extRouter: `0x${string}`;
      extCalldata: `0x${string}`;
      needScale: boolean;
    };
  };
  limitOrderData: {
    limitRouter: `0x${string}`;
    epsSkipMarket: bigint;
    normalFills: {}[];
    flashFills: {}[];
    optData: `0x${string}`;
  };
}

export const bundlerEnter = (pendle: PendleSwapParams, params: BundlerEnterParams) => {
  const extracted = pendle.contractCallParamsName.reduce<ExtractedParams>(
    (acc, name, i) => {
      const param = pendle.contractCallParams[i];

      switch (name) {
        // fixme parse with zod
        case "market": {
          if (!isHex(param)) {
            throw new Error(`Invalid market address: ${param}`);
          }

          return { ...acc, market: param };
        }

        case "minPtOut": {
          return { ...acc, minPt: BigInt(param) };
        }

        case "guessPtOut": {
          if (!param || typeof param !== "object") {
            throw new Error(`Invalid guessPtOut: ${param}`);
          }

          return {
            ...acc,
            approxParams: {
              guessMin: BigInt(param.guessMin),
              guessMax: BigInt(param.guessMax),
              guessOffchain: BigInt(param.guessOffchain),
              maxIteration: BigInt(param.maxIteration),
              eps: BigInt(param.eps),
            },
          };
        }
        case "input": {
          if (!param || typeof param !== "object") {
            throw new Error(`Invalid input: ${param}`);
          }

          if (!isHex(param.tokenIn)) {
            throw new Error(`Invalid tokenIn: ${param.tokenIn}`);
          }

          if (!isHex(param.tokenMintSy)) {
            throw new Error(`Invalid tokenMintSy: ${param.tokenMintSy}`);
          }

          if (!isHex(param.pendleSwap)) {
            throw new Error(`Invalid pendleSwap: ${param.pendleSwap}`);
          }

          if (!param.swapData || typeof param.swapData !== "object") {
            throw new Error("Invalid swapData");
          }

          if (!isHex(param.swapData.extRouter)) {
            throw new Error(`Invalid extRouter: ${param.swapData.extRouter}`);
          }

          if (!isHex(param.swapData.extCalldata)) {
            throw new Error(
              `Invalid extCalldata: ${param.swapData.extCalldata}`
            );
          }

          return {
            ...acc,
            tokenInput: {
              tokenIn: param.tokenIn,
              netTokenIn: BigInt(param.netTokenIn),
              tokenMintSy: param.tokenMintSy,
              pendleSwap: param.pendleSwap,
              swapData: {
                swapType: Number(param.swapData.swapType),
                extRouter: param.swapData.extRouter,
                extCalldata: param.swapData.extCalldata,
                needScale: Boolean(param.swapData.needScale),
              },
            },
          };
        }
        case "limit": {
          if (!param || typeof param !== "object") {
            throw new Error("Invalid limit");
          }

          if (!isHex(param.limitRouter)) {
            throw new Error(`Invalid limitRouter: ${param.limitRouter}`);
          }

          if (!isHex(param.optData)) {
            throw new Error(`Invalid optData: ${param.optData}`);
          }

          return {
            ...acc,
            limitOrderData: {
              limitRouter: param.limitRouter,
              epsSkipMarket: BigInt(param.epsSkipMarket),
              normalFills: param.normalFills,
              flashFills: param.flashFills,
              optData: param.optData,
            },
          };
        }
      }

      return acc;
    },
    {} as ExtractedParams
  );

  const data = encodeFunctionData({
    abi: pendleBundlerAbi,
    functionName: "enter",
    args: [
      params.pool,
      extracted.market,
      extracted.minPt,
      params.longAmount,
      false,
      params.limitPriceX96,
      extracted.approxParams,
      extracted.tokenInput,
      // @ts-expect-error fixme typing
      extracted.limitOrderData,
    ],
  });

  return data;
};
