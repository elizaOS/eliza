import axios from 'axios';
import { parseUnits, formatUnits, parseEther } from 'ethers'; // Assuming ethers v6 for bigint handling
import type { IAgentRuntime } from '@elizaos/core';
import { PolygonRpcService } from './PolygonRpcService'; // Import PolygonRpcService

/**
 * Structure of the expected successful response from the PolygonScan Gas Oracle API.
 * Prices are typically returned in Gwei as strings.
 */
interface PolygonScanGasResult {
  LastBlock: string;
  SafeGasPrice: string;
  ProposeGasPrice: string;
  FastGasPrice: string;
  suggestBaseFee?: string; // Original expected field (Gwei)
  BaseFee?: string; // New potential field (likely MATIC/ETH?)
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
 * @returns Value in Wei (as bigint), or null if conversion fails.
 */
function gweiToWei(gweiString: string | undefined | null): bigint | null {
  // Allow undefined/null input
  // Check if input is a valid string and looks like a number (simple check)
  if (
    typeof gweiString !== 'string' ||
    gweiString.trim() === '' ||
    Number.isNaN(Number(gweiString))
  ) {
    console.warn(`Invalid input provided to gweiToWei: ${gweiString}. Returning null.`);
    return null; // Return null for invalid inputs
  }

  try {
    // Use parseUnits which handles decimals correctly
    return parseUnits(gweiString, 'gwei');
  } catch (error) {
    console.error(`Error converting Gwei string "${gweiString}" to Wei:`, error);
    // Explicitly return null on parsing error as well
    return null;
    // throw new Error(`Invalid Gwei value format: ${gweiString}`); // Don't throw
  }
}

/**
 * Fetches gas price estimates from PolygonScan API with fallback to eth_gasPrice.
 *
 * @param runtime The IAgentRuntime to access services.
 * @returns A promise resolving to GasPriceEstimates object with values in Wei.
 */
export const getGasPriceEstimates = async (runtime: IAgentRuntime): Promise<GasPriceEstimates> => {
  const apiKey = runtime.getSetting('POLYGONSCAN_KEY');

  if (!apiKey) {
    console.warn('POLYGONSCAN_KEY not found in configuration. Falling back to eth_gasPrice.');
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
      console.error(`PolygonScan API returned an error: ${data.message} (Status: ${data.status})`);
      console.warn('Falling back to eth_gasPrice.');
      return fetchFallbackGasPrice(runtime);
    }

    const { SafeGasPrice, ProposeGasPrice, FastGasPrice, suggestBaseFee, BaseFee } = data.result;

    // Convert Gwei strings for priority fees to Wei bigints
    const safeWei = gweiToWei(SafeGasPrice);
    const proposeWei = gweiToWei(ProposeGasPrice);
    const fastWei = gweiToWei(FastGasPrice);

    // Determine base fee, prioritizing BaseFee (assuming MATIC/ETH) then suggestBaseFee (Gwei)
    let baseFeeWei: bigint | null = null;
    try {
      if (BaseFee !== undefined && BaseFee !== null) {
        // Check BaseFee format before parsing (simple check)
        if (typeof BaseFee === 'string' && !Number.isNaN(Number(BaseFee))) {
          baseFeeWei = parseEther(BaseFee);
        } else {
          console.warn(`Invalid BaseFee format received: ${BaseFee}. Skipping.`);
          // Try suggestBaseFee if BaseFee is invalid
          baseFeeWei = gweiToWei(suggestBaseFee);
        }
      } else {
        // Fallback to suggestBaseFee (Gwei) if BaseFee is missing or invalid
        baseFeeWei = gweiToWei(suggestBaseFee);
      }
    } catch (error: unknown) {
      // Catch errors from parseEther or gweiToWei inside this block
      console.error('Error parsing base fee from PolygonScan:', error);
      baseFeeWei = null;
    }

    // Construct the result, allowing for nulls from gweiToWei
    return {
      safeLow: safeWei !== null ? { maxPriorityFeePerGas: safeWei } : null,
      average: proposeWei !== null ? { maxPriorityFeePerGas: proposeWei } : null,
      fast: fastWei !== null ? { maxPriorityFeePerGas: fastWei } : null,
      estimatedBaseFee: baseFeeWei,
      fallbackGasPrice: null, // Indicate fallback was not used
    };
  } catch (error: unknown) {
    // This catch block now primarily handles axios network errors or API status != 200
    console.error('Error fetching or parsing PolygonScan gas estimates:', error);
    console.warn('Falling back to eth_gasPrice.');
    return fetchFallbackGasPrice(runtime);
  }
};

/**
 * Fetches gas price using the eth_gasPrice RPC method as a fallback.
 *
 * @param runtime The IAgentRuntime to access services.
 * @returns A promise resolving to a simplified GasPriceEstimates object.
 */
const fetchFallbackGasPrice = async (runtime: IAgentRuntime): Promise<GasPriceEstimates> => {
  try {
    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      console.error('PolygonRpcService not available for fallback gas price.');
      throw new Error('PolygonRpcService not available'); // Or return all-null estimates
    }

    const l2Provider = rpcService.getL2Provider();
    const feeData = await l2Provider.getFeeData();
    const gasPriceWei = feeData.gasPrice;

    if (gasPriceWei === null || gasPriceWei === undefined) {
      console.warn('Fallback eth_gasPrice (via getFeeData) returned null or undefined.');
      return {
        safeLow: null,
        average: null,
        fast: null,
        estimatedBaseFee: null,
        fallbackGasPrice: null, // Explicitly null
      };
    }

    console.warn(`Using fallback eth_gasPrice: ${formatUnits(gasPriceWei, 'gwei')} Gwei`);

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
  } catch (error: unknown) {
    console.error('Error fetching fallback gas price via eth_gasPrice:', error);
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
