export const getUniswapQuoterRouter = (chainId: string) => {
  let UNISWAP_V3_QUOTER: string;
  let UNISWAP_V3_ROUTER: string;

  // Set Uniswap V3 contract addresses based on the chain ID
  switch (chainId) {
    case '8453': // Base Mainnet
      UNISWAP_V3_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
      UNISWAP_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
      break;
    case '1': // Ethereum Mainnet
    case '42161': // Arbitrum
      UNISWAP_V3_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
      UNISWAP_V3_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
      break;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  console.log(`Using Uniswap V3 Quoter: ${UNISWAP_V3_QUOTER}`);
  console.log(`Using Uniswap V3 Router: ${UNISWAP_V3_ROUTER}`);

  return {
    UNISWAP_V3_QUOTER,
    UNISWAP_V3_ROUTER,
  };
};
