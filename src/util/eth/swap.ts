import {
  Chain,
  formatUnits,
  isHex,
  maxUint256,
  StateOverride,
  toHex,
} from "viem";
import { estimationTemplate } from "../../templates";
import type { SwapEstimation, SwapInfo } from "../../types/swap";
import { TokenDataWithInfo } from "src/types/token";
import { IAgentRuntime } from "@elizaos/core";
import { CalldataWithDescription } from "src/types/tx";
import { getClient } from "./client";
import { getSwapRouteV1, postSwapRouteV1 } from "src/api/swap/kyber";
import { getPendleSwap } from "src/api/swap/pendle";
import { getAllowance, getErc20ApprovalStorageSlot } from "./allowance";
import { getToken, upsertToken } from "../db";
import { wethHelper } from "./weth";

export const formatEstimation = (estimation: SwapEstimation) => {
  const usd = Boolean(estimation.amountOutUsd && estimation.gasUsd);

  const hasFailedGasEstimation = [estimation.gas, estimation.gasPrice].some(
    (v) => !v || v === "failed"
  );

  const gas = hasFailedGasEstimation
    ? "failed to estimate gas"
    : formatUnits(
        BigInt(estimation.gas ?? "0") * BigInt(estimation.gasPrice ?? "0"),
        18
      );

  const amountOut = formatUnits(
    BigInt(estimation.amountOut ?? "0"),
    estimation.decimals
  );

  return estimationTemplate(usd)
    .replace("{{amountOut}}", amountOut)
    .replace("{{symbol}}", estimation.symbol)
    .replace("{{amountOutUsd}}", estimation.amountOutUsd ?? "")
    .replace("{{gas}}", gas)
    .replace("{{gasUsd}}", estimation.gasUsd ?? "");
};

interface SwapParams {
  address: `0x${string}`;
  chain: Chain;
  amountIn: bigint;
  decimals: number;
}

export function selectSwapRouter(
  tokenIn: TokenDataWithInfo,
  tokenOut: TokenDataWithInfo
) {
  // by default use kyber
  let router: SwapInfo = { type: "kyber" };

  if (tokenIn.info?.swap?.type === "pendle") {
    router = tokenIn.info.swap;
  } else if (tokenOut.info?.swap?.type === "pendle") {
    router = tokenOut.info.swap;
  }

  if (router.type === "kyber") {
    return async (
      runtime: IAgentRuntime,
      { address, amountIn, chain, decimals }: SwapParams
    ) => {
      const client = getClient(chain);
      const calls: CalldataWithDescription[] = [];
      const clientId = runtime.getSetting("KYBER_CLIENT_ID");
      const amount = formatUnits(amountIn, decimals);

      const route = await getSwapRouteV1({
        chainId: chain.id,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountIn.toString() as `${number}`,
        clientId,
      });

      const routeSummary = route?.data?.routeSummary;
      const routerAddress = route?.data?.routerAddress;

      if (!isHex(routerAddress) || !routeSummary) {
        throw new Error(
          `Failed to get swap route, received: ${JSON.stringify(route)}`
        );
      }

      const build = await postSwapRouteV1({
        address,
        route,
        clientId,
        chainId: chain.id,
      });

      if (!build?.data) {
        throw new Error(
          `Failed to build swap route, received: ${JSON.stringify(build)}`
        );
      }

      if (tokenIn.address) {
        const { approve } = await getAllowance({
          sender: address,
          spender: routerAddress,
          token: tokenIn.address,
          amount: amountIn,
          client,
          decimals: tokenIn.decimals,
          symbol: tokenIn.symbol,
        });

        if (approve) {
          calls.push(approve);
        }
      }

      calls.push({
        to: routerAddress,
        data: build.data.data as `0x${string}`,
        value: build.data.transactionValue,
        title: `Swap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}`,
        description: `Swap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol} on KyberSwap`,
      });

      const estimation: SwapEstimation = {
        decimals: tokenOut.decimals,
        symbol: tokenOut.symbol,
        amountOut: routeSummary.amountOut,
        gas: routeSummary.gas,
        gasPrice: routeSummary.gasPrice,
        amountOutUsd: routeSummary.amountOutUsd,
        gasUsd: routeSummary.gasUsd,
      };

      return { calls, estimation };
    };
  } else {
    const { market, slippage } = router;

    return async (
      runtime: IAgentRuntime,
      { address, amountIn, chain, decimals }: SwapParams
    ): Promise<{
      calls: CalldataWithDescription[];
      estimation: SwapEstimation;
    }> => {
      const amount = formatUnits(amountIn, decimals);
      const client = getClient(chain);
      const calls: CalldataWithDescription[] = [];

      // pendle router does not support native tokens; need to wrap first
      const weth = await wethHelper(runtime, {
        chainId: chain.id,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
      });

      if (weth?.side === "in") {
        calls.push(weth.getCall(amountIn));
      }

      const { data: swap, tx } = await getPendleSwap({
        chainId: chain.id.toString() as `${number}`,
        market,
        receiver: address,
        slippage: slippage?.toString() as `${number}`,
        enableAggregator: "true",
        amountIn: amountIn.toString() as `${number}`,
        tokenIn: (tokenIn.address ?? weth?.address)!,
        tokenOut: (tokenOut.address ?? weth?.address)!,
      }) ?? {};

      if (!swap || !tx) {
        throw new Error("Failed to get pendle swap data");
      }

      const { amountOut } = swap;
      const { to, data, value } = tx;

      if (!amountOut || !isHex(to) || !isHex(data)) {
        throw new Error("Failed to get pendle swap data");
      }

      let allowanceSlot: `0x${string}` | undefined;

      const { approve, allowance } = await getAllowance({
        sender: address,
        spender: to,
        token: (tokenIn.address ?? weth?.address)!,
        amount: amountIn,
        client,
        decimals: tokenIn.decimals,
        symbol: tokenIn.symbol,
      });

      if (approve) {
        calls.push(approve);

        if (tokenIn.info?.allowanceSlot) {
          allowanceSlot = tokenIn.info.allowanceSlot;
        } else {
          // fixme need to calculate allowance slot in dedicated script
          /*
          const { storageSlot } = await getErc20ApprovalStorageSlot(
            allowance,
            client,
            tokenIn.address,
            address,
            to,
            30
          );

          console.log({ storageSlot });
          allowanceSlot = storageSlot;
          const { address: tokenInAddress, info, ...rest } = tokenIn;

          await upsertToken(runtime, {
            ...rest,
            address: tokenInAddress,
            chainId: chain.id,
            info: { ...info, allowanceSlot },
          });
          */
        }
      }

      calls.push({
        to,
        data,
        value,
        title: `Swap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}`,
        description: `Swap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol} on Pendle`,
      });

      const estimation: SwapEstimation = {
        amountOut,
        decimals: tokenOut.decimals,
        symbol: tokenOut.symbol,
        // todo fix gas estimation
        gas: "failed",
        gasPrice: "failed",
      };

      /*
      let stateOverride: StateOverride | undefined;

      if (allowanceSlot) {
        stateOverride = [
          {
            address,
            stateDiff: [
              {
                slot: allowanceSlot,
                value: toHex(maxUint256),
              },
            ],
          },
        ];
      }

      // fixme gas estimation

      const gas = await client.estimateGas({
        account: address,
        to,
        data,
        value,
        stateOverride,
      });

      console.log({ gas });
      // override allowance state and estimate gas
      */

      return { calls, estimation: estimation as SwapEstimation };
    };
  }
}
