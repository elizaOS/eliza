declare module "@polyagent/contracts/deployments/local" {
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
    polyagentOracle: string;
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

declare module "@polyagent/contracts/deployments/base-sepolia" {
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
    polyagentOracle?: string;
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

declare module "@polyagent/contracts/deployments/base" {
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
    polyagentOracle?: string;
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
