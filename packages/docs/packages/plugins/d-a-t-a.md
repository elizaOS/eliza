# `@elizaos-plugins/plugin-d.a.t.a`


The **`@elizaos-plugins/plugin-d.a.t.a`** (Data Authentication, Trust, and Attestation framework) plugin is a plugin from CARV. It enhances the Eliza Agent Framework with powerful data processing capabilities, enabling agents to analyze, transform, and derive insights from various data sources.

- **Comprehensive Data Processing:** Transform raw data into actionable insights through advanced analysis techniques.
- **Flexible Data Handling:** Support for multiple data formats and sources, from CSV to JSON and APIs.
- **Intelligent Analysis:** Leverage statistical methods and machine learning techniques for deeper understanding.

Integrate **`@elizaos-plugins/plugin-d.a.t.a`** to empower your AI agents with sophisticated data analysis capabilities.

## Use Cases

- On-chain stats fetching.
- Token info.
- On-chain address tracking (CARV ID required).

## Example

**Q**: Can you tell me about the AAVE

**A**: Searching the results from d.a.t.a, please wait a moment... Analyzing Aave (AAVE) token data. Aave is a decentralized lending and borrowing protocol operating on multiple blockchains, including Ethereum, Polygon, Avalanche, and others. The AAVE token is primarily used for governance, allowing holders to vote on protocol upgrades and changes. It also serves as a safety mechanism, where staked AAVE can be used to cover shortfalls in the protocol. Aave is categorized under 'Decentralized Finance (DeFi)', 'Lending/Borrowing Protocols', and multiple ecosystem integrations, indicating its broad utility and adoption across various blockchain environments. The token is deployed on 12 different platforms, showcasing its cross-chain capabilities. Would you like a deeper analysis of its technical features, market trends, or specific use cases?

Logs:
```
 ◎ LOGS
   %%%% D.A.T.A. Querying token info for ticker:
   AAVE

 ["◎ Querying token info for ticker: AAVE"]

 ["◎ Successfully retrieved token info for AAVE"]

 ◎ LOGS
   %%%% D.A.T.A. queryResult:
   {
    "success": true,
    "data": {
      "ticker": "aave",
      "symbol": "aave",
      "name": "Aave",
      "platform": "ethereum",
      "categories": [
        "Decentralized Finance (DeFi)",
        "Governance",
        "Yield Farming",
        "BNB Chain Ecosystem",
        "Lending/Borrowing Protocols",
        "Avalanche Ecosystem",
        "Polygon Ecosystem",
        "Near Protocol Ecosystem",
        "Fantom Ecosystem",
        "Harmony Ecosystem",
        "Arbitrum Ecosystem",
        "Ethereum Ecosystem",
        "Optimism Ecosystem",
        "Index Coop Defi Index",
        "Energi Ecosystem",
        "Sora Ecosystem",
        "Huobi ECO Chain Ecosystem",
        "GMCI DeFi Index",
        "Blockchain Capital Portfolio",
        "Index Coop Index",
        "GMCI Index",
        "World Liberty Financial Portfolio"
      ],
      "contract_infos": [
        {
          "platform": "near-protocol",
          "address": "7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.factory.bridge.near"
        },
        {
          "platform": "huobi-token",
          "address": "0x202b4936fe1a82a4965220860ae46d7d3939bb25"
        },
        {
          "platform": "fantom",
          "address": "0x6a07a792ab2965c72a5b8088d3a069a7ac3a993b"
        },
        {
          "platform": "energi",
          "address": "0xa7f2f790355e0c32cab03f92f6eb7f488e6f049a"
        },
        {
          "platform": "binance-smart-chain",
          "address": "0xfb6115445bff7b52feb98650c87f44907e58f802"
        },
        {
          "platform": "ethereum",
          "address": "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"
        },
        {
          "platform": "optimistic-ethereum",
          "address": "0x76fb31fb4af56892a25e32cfc43de717950c9278"
        },
        {
          "platform": "polygon-pos",
          "address": "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
        },
        {
          "platform": "harmony-shard-0",
          "address": "0xcf323aad9e522b93f11c352caa519ad0e14eb40f"
        },
        {
          "platform": "arbitrum-one",
          "address": "0xba5ddd1f9d7f570dc94a51479a000e3bce967196"
        },
        {
          "platform": "avalanche",
          "address": "0x63a72806098bd3d9520cc43356dd78afe5d386d9"
        },
        {
          "platform": "sora",
          "address": "0x0091bd8d8295b25cab5a7b8b0e44498e678cfc15d872ede3215f7d4c7635ba36"
        }
      ],
      "price": 0
    },
    "metadata": {
      "queryTime": "2025-01-24T15:02:01.461Z",
      "queryType": "token",
      "executionTime": 1362,
      "cached": false,
      "queryDetails": {
        "params": {
          "ticker": "AAVE",
          "platform": "ethereum"
        }
      }
    }
  }
```

Start leveraging the power of data analysis in your AI applications with **`@elizaos-plugins/plugin-d.a.t.a`** and unlock new possibilities for your Eliza agents.