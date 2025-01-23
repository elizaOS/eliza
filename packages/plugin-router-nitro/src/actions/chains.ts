import * as viemChains from "viem/chains";

// Create chains object from all available viem chains
const chains = Object.values(viemChains).reduce((acc, chain) => {
  if (chain && typeof chain === 'object' && 'id' in chain) {
    acc[chain.id] = chain;
  }
  return acc;
}, {});

export const getRpcUrlFromChainId = (chainId) => {
  const chain = chains[chainId];
  if (!chain) {
    throw new Error(`Chain ID ${chainId} not found`);
  }
  
  return chain.rpcUrls.default.http[0];
}

// Helper to get chain object
export const getChainFromChainId = (chainId) => {
  const chain = chains[chainId];
  if (!chain) {
    throw new Error(`Chain ID ${chainId} not found`);
  }
  
  return chain;
}

export const getBlockExplorerFromChainId = (chainId) => {
    const chain = chains[chainId];
    if (!chain) {
      throw new Error(`Chain ID ${chainId} not found`);
    }
    
    if (!chain.blockExplorers || !chain.blockExplorers.default) {
      throw new Error(`Block explorer not found for Chain ID ${chainId}`);
    }
  
    return {
      url: chain.blockExplorers.default.url,
    };
};

export { chains };
