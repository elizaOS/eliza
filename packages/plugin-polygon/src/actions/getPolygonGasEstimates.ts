import type { Action, IAgentRuntime } from '@elizaos/core';
import { getGasPriceEstimates, type GasPriceEstimates } from '../services/GasService.js';

export const getPolygonGasEstimatesAction: Action = {
  name: 'GET_POLYGON_GAS_ESTIMATES',
  description: 'Gets current gas price estimates for Polygon from PolygonScan.',
  validate: async () => true,
  handler: async (runtime: IAgentRuntime) => {
    const estimates: GasPriceEstimates = await getGasPriceEstimates(runtime);
    let text = 'Polygon Gas Estimates (Wei):\n';
    text += `  Safe Low Priority: ${estimates.safeLow?.maxPriorityFeePerGas?.toString() ?? 'N/A'}\n`;
    text += `  Average Priority:  ${estimates.average?.maxPriorityFeePerGas?.toString() ?? 'N/A'}\n`;
    text += `  Fast Priority:     ${estimates.fast?.maxPriorityFeePerGas?.toString() ?? 'N/A'}\n`;
    text += `  Estimated Base:  ${estimates.estimatedBaseFee?.toString() ?? 'N/A'}`;
    if (estimates.fallbackGasPrice) {
      text += `\n  (Used Fallback Price: ${estimates.fallbackGasPrice.toString()})`;
    }

    // Create a serializable version of the estimates with BigInt values converted to strings
    const serializableEstimates = {
      safeLow: estimates.safeLow
        ? {
            maxPriorityFeePerGas: estimates.safeLow.maxPriorityFeePerGas
              ? estimates.safeLow.maxPriorityFeePerGas.toString()
              : null,
          }
        : null,
      average: estimates.average
        ? {
            maxPriorityFeePerGas: estimates.average.maxPriorityFeePerGas
              ? estimates.average.maxPriorityFeePerGas.toString()
              : null,
          }
        : null,
      fast: estimates.fast
        ? {
            maxPriorityFeePerGas: estimates.fast.maxPriorityFeePerGas
              ? estimates.fast.maxPriorityFeePerGas.toString()
              : null,
          }
        : null,
      estimatedBaseFee: estimates.estimatedBaseFee ? estimates.estimatedBaseFee.toString() : null,
      fallbackGasPrice: estimates.fallbackGasPrice ? estimates.fallbackGasPrice.toString() : null,
    };

    return {
      text,
      actions: ['GET_POLYGON_GAS_ESTIMATES'],
      data: serializableEstimates,
    };
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'What are the current gas prices on Polygon?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Polygon Gas Estimates (Wei):\n  Safe Low Priority: 1\n  Average Priority:  2\n  Fast Priority:     3\n  Estimated Base:  10000000000',
          action: 'POLYGON_GET_POLYGON_GAS_ESTIMATES',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get Polygon gas estimates' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Polygon Gas Estimates (Wei):\n  Safe Low Priority: 1\n  Average Priority:  2\n  Fast Priority:     3\n  Estimated Base:  10000000000',
          action: 'POLYGON_GET_POLYGON_GAS_ESTIMATES',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Fetch gas fees for Polygon network' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Polygon Gas Estimates (Wei):\n  Safe Low Priority: 1\n  Average Priority:  2\n  Fast Priority:     3\n  Estimated Base:  10000000000',
          action: 'POLYGON_GET_POLYGON_GAS_ESTIMATES',
        },
      },
    ],
  ],
};
