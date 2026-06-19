declare module "@feed/contracts/deployments/local" {
  interface Contracts {
    diamond: string;
    diamondCutFacet: string;
    diamondLoupeFacet: string;
    predictionMarketFacet: string;
    oracleFacet: string;
    liquidityPoolFacet: string;
    perpetualMarketFacet: string;
    referralSystemFacet: string;
    priceStorageFacet: string;
    identityRegistry: string;
    reputationSystem: string;
    feedOracle: string;
    banManager?: string;
    chainlinkOracle?: string;
    mockOracle?: string;
    testToken?: string;
  }

  interface Deployment {
    network: string;
    chainId: number;
    contracts: Contracts;
    deployer: string;
    timestamp: string;
    blockNumber: number;
  }

  const deployment: Deployment;
  export default deployment;
}

declare module "@feed/contracts/deployments/base-sepolia" {
  interface Contracts {
    diamond: string;
    diamondCutFacet: string;
    diamondLoupeFacet: string;
    predictionMarketFacet: string;
    oracleFacet: string;
    liquidityPoolFacet: string;
    perpetualMarketFacet: string;
    referralSystemFacet: string;
    priceStorageFacet: string;
    identityRegistry: string;
    reputationSystem: string;
    feedOracle?: string;
    banManager?: string;
    chainlinkOracle?: string;
    mockOracle?: string;
    testToken?: string;
  }

  interface Deployment {
    network: string;
    chainId: number;
    contracts: Contracts;
    deployer: string;
    timestamp: string;
    blockNumber: number;
  }

  const deployment: Deployment;
  export default deployment;
}

declare module "@feed/contracts/deployments/base" {
  interface Contracts {
    diamond: string;
    diamondCutFacet: string;
    diamondLoupeFacet: string;
    predictionMarketFacet: string;
    oracleFacet: string;
    liquidityPoolFacet: string;
    perpetualMarketFacet: string;
    referralSystemFacet: string;
    priceStorageFacet: string;
    identityRegistry: string;
    reputationSystem: string;
    feedOracle?: string;
    banManager?: string;
  }

  interface Deployment {
    network: string;
    chainId: number;
    contracts: Contracts;
    deployer: string;
    timestamp: string;
    blockNumber: number;
  }

  const deployment: Deployment;
  export default deployment;
}
