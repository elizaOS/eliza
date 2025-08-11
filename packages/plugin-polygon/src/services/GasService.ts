import axios from 'axios';
import { parseUnits, formatUnits } from 'ethers'; // Assuming ethers v6 for bigint handling
import type { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';

// Placeholder for core RPC interaction wrapper - replace with actual ElizaOS mechanism
const coreRpc = {
  eth_gasPrice: async (): Promise<bigint> => {
    // In a real scenario, this would call the configured Polygon RPC endpoint
    elizaLogger.warn('Using fallback eth_gasPrice RPC method.');
    // Simulating a typical gas price in Wei (e.g., 50 Gwei)
    return parseUnits('50', 'gwei');
  },
};

/**
 * Structure of the expected successful response from the PolygonScan Gas Oracle API.
 * Prices are typically returned in Gwei as strings.
 */
interface PolygonScanGasResult {
  LastBlock: string;
  SafeGasPrice: string;
  ProposeGasPrice: string;
  FastGasPrice: string;
  suggestBaseFee: string; // Base fee estimate in Gwei
  gasUsedRatio: string;
}

interface PolygonScanGasOracleResponse {
  status: string;
  message: string;
  result: PolygonScanGasResult;
}

/**
 * Standardized return structure for gas price estimates.
 * All values are represented in Wei as bigints.
 * Fields can be null if data is unavailable (e.g., during fallback).
 */
export interface GasPriceEstimates {
  safeLow: {
    maxPriorityFeePerGas: bigint | null; // Corresponds to SafeGasPrice
    // maxFeePerGas might be calculated later using baseFee + priorityFee
  } | null;
  average: {
    maxPriorityFeePerGas: bigint | null; // Corresponds to ProposeGasPrice
  } | null;
  fast: {
    maxPriorityFeePerGas: bigint | null; // Corresponds to FastGasPrice
  } | null;
  /** Estimated next block base fee in Wei. */
  estimatedBaseFee: bigint | null; // Corresponds to suggestBaseFee
  /** Fallback gas price from eth_gasPrice in Wei, if used. */
  fallbackGasPrice?: bigint | null;
}

const POLYGONSCAN_API_URL = 'https://api.polygonscan.com/api';

/**
 * Converts a Gwei string value to a Wei bigint value.
 * Handles potential decimal values in the Gwei string.
 * @param gweiString Value in Gwei (as string).
 * @returns Value in Wei (as bigint).
 */
function gweiToWei(gweiString: string): bigint {
  try {
    // Use parseUnits which handles decimals correctly
    return parseUnits(gweiString, 'gwei');
  } catch (error) {
    elizaLogger.error(`Error converting Gwei string "${gweiString}" to Wei:`, error);
    throw new Error(`Invalid Gwei value format: ${gweiString}`);
  }
}

/**
 * Fetches gas price estimates from PolygonScan API with fallback to eth_gasPrice.
 *
 * @returns A promise resolving to GasPriceEstimates object with values in Wei.
 */
export const getGasPriceEstimates = async (runtime: IAgentRuntime): Promise<GasPriceEstimates> => {
  const apiKey = runtime.getSetting('POLYGONSCAN_KEY');

  if (!apiKey) {
    elizaLogger.warn('POLYGONSCAN_KEY not found in configuration. Falling back to eth_gasPrice.');
    return fetchFallbackGasPrice();
  }

  const params = {
    module: 'gastracker',
    action: 'gasoracle',
    apikey: apiKey,
  };

  try {
    const response = await axios.get<PolygonScanGasOracleResponse>(POLYGONSCAN_API_URL, { params });

    if (response.status !== 200) {
      throw new Error(`PolygonScan API request failed with status ${response.status}`);
    }

    const data = response.data;

    // PolygonScan sometimes returns status "0" with a message for errors (like invalid key)
    if (data.status !== '1' || !data.result) {
      elizaLogger.error(
        `PolygonScan API returned an error: ${data.message} (Status: ${data.status})`
      );
      elizaLogger.warn('Falling back to eth_gasPrice.');
      return fetchFallbackGasPrice();
    }

    const { SafeGasPrice, ProposeGasPrice, FastGasPrice, suggestBaseFee } = data.result;

    // Convert Gwei strings to Wei bigints
    const safeWei = gweiToWei(SafeGasPrice);
    const proposeWei = gweiToWei(ProposeGasPrice);
    const fastWei = gweiToWei(FastGasPrice);
    const baseFeeWei = gweiToWei(suggestBaseFee);

    return {
      safeLow: { maxPriorityFeePerGas: safeWei },
      average: { maxPriorityFeePerGas: proposeWei },
      fast: { maxPriorityFeePerGas: fastWei },
      estimatedBaseFee: baseFeeWei,
      fallbackGasPrice: null, // Indicate fallback was not used
    };
  } catch (error) {
    elizaLogger.error('Error fetching or parsing PolygonScan gas estimates:', error);
    elizaLogger.warn('Falling back to eth_gasPrice.');
    return fetchFallbackGasPrice();
  }
};

/**
 * Fetches gas price using the eth_gasPrice RPC method as a fallback.
 *
 * @returns A promise resolving to a simplified GasPriceEstimates object.
 */
const fetchFallbackGasPrice = async (): Promise<GasPriceEstimates> => {
  try {
    const gasPriceWei = await coreRpc.eth_gasPrice();

    // When using fallback, we only have a single gas price.
    // We might assign it to 'average' priority or provide it separately.
    // We set priority fees and base fee to null as they aren't directly available.
    // Providing the raw fallback value allows consumers to decide how to use it.
    return {
      safeLow: null,
      average: null, // Or potentially { maxPriorityFeePerGas: gasPriceWei } if treating as priority
      fast: null,
      estimatedBaseFee: null,
      fallbackGasPrice: gasPriceWei, // Provide the fallback value explicitly
    };
  } catch (rpcError) {
    elizaLogger.error('Error fetching fallback gas price via eth_gasPrice:', rpcError);
    // Return empty estimates if fallback also fails
    return {
      safeLow: null,
      average: null,
      fast: null,
      estimatedBaseFee: null,
      fallbackGasPrice: null,
    };
  }
};
