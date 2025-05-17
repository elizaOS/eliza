import axios from 'axios';
import { IAgentRuntime, logger } from '@elizaos/core';
import { formatUnits, parseUnits } from '../utils/formatters';
import { PolygonRpcService } from './PolygonRpcService';
import { GasPriceInfo } from '../types';

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
    // Use our formatters from utils
    return parseUnits(gweiString, 9);
  } catch (error) {
    logger.error(`Error converting Gwei string "${gweiString}" to Wei:`, error);
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
    logger.warn('POLYGONSCAN_KEY not found in configuration. Falling back to RPC gas price.');
    return fetchFallbackGasPrice(runtime);
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
      logger.error(`PolygonScan API returned an error: ${data.message} (Status: ${data.status})`);
      logger.warn('Falling back to RPC gas price.');
      return fetchFallbackGasPrice(runtime);
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
    logger.error('Error fetching or parsing PolygonScan gas estimates:', error);
    logger.warn('Falling back to RPC gas price.');
    return fetchFallbackGasPrice(runtime);
  }
};

/**
 * Fetches gas price using the RPC provider's getGasPrice method as a fallback.
 *
 * @returns A promise resolving to a simplified GasPriceEstimates object.
 */
const fetchFallbackGasPrice = async (runtime: IAgentRuntime): Promise<GasPriceEstimates> => {
  try {
    // Get the RPC service
    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      throw new Error('PolygonRpcService not available');
    }

    // Get gas price from Polygon L2
    const gasPriceWei = await rpcService.getGasPrice('L2');

    // When using fallback, we only have a single gas price.
    // We set priority fees and base fee to null as they aren't directly available.
    return {
      safeLow: null,
      average: null,
      fast: null,
      estimatedBaseFee: null,
      fallbackGasPrice: gasPriceWei, // Provide the fallback value directly
    };
  } catch (error) {
    logger.error('Error fetching fallback gas price:', error);
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

// Example Usage (remove in final implementation)
/*
async function testGas() {
    // Make sure to set POLYGONSCAN_API_KEY in your environment for testing
    // e.g., export POLYGONSCAN_API_KEY='YourApiKeyToken'
    console.log('Fetching gas estimates...');
    const estimates = await getGasPriceEstimates();
    console.log('Gas Estimates (Wei):');
    console.log('  Safe Low Priority Fee:', estimates.safeLow?.maxPriorityFeePerGas?.toString());
    console.log('  Average Priority Fee: ', estimates.average?.maxPriorityFeePerGas?.toString());
    console.log('  Fast Priority Fee:    ', estimates.fast?.maxPriorityFeePerGas?.toString());
    console.log('  Estimated Base Fee: ', estimates.estimatedBaseFee?.toString());
    if (estimates.fallbackGasPrice !== undefined && estimates.fallbackGasPrice !== null) {
        console.log('  Fallback Gas Price: ', estimates.fallbackGasPrice.toString(), '(used fallback)');
    }
}

testGas().catch(console.error);
*/
