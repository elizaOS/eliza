---
title: Compass Labs Builder Demo - AI Trading Agent Infrastructure
description: A presentation on Compass Labs' infrastructure for AI trading agents, showcasing their platform for automated trading and market analysis.
keywords: [eliza-os, builder-demo, trading, ai-agents, compass-labs, defi]
date: 2025-03-21
---

# Compass Labs Plugin Tutorial Session Summary

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/-JpiqOyicQo"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>

- Date: 2025-03-21
- YouTube Link: https://www.youtube.com/watch?v=-JpiqOyicQo

## Introduction [0:00-4:30]

- Tutorial session featuring Eidar, founding engineer of Compass Labs
- The plugin enables direct execution into DeFi platforms through Eliza Labs

## Compass Labs Overview [4:30-8:30]

- **Problem Addressed**: DeFi complexity, especially for non-crypto users
- **Goal**: Abstract away technical complexities like Solidity knowledge
- **Main Products**:
  1. Backtesting tool (supports Uniswap, Aave, GMX)
  2. Compass API for direct execution in DeFi

## Technical Capabilities [8:30-13:30]

- **Supported Blockchains**: Ethereum, Arbitrum, and Base
- **Supported Protocols**: Uniswap, Aave, and Aerodrome
- **API Types**:
  1. Read endpoints: For querying off-chain data
  2. Transaction endpoints: Provide unsigned transactions for user actions

## Live Demo [13:30-27:00]

- Eidar demonstrates the plugin using a Telegram client interface
- Key actions demonstrated:
  - **[16:45]** Fetching Aave positions (~$48 worth of crypto)
  - **[20:30]** Executing Aave withdrawal
  - **[22:30]** Checking USDC balance (48.6 USDC)
  - **[23:00]** Swapping USDC to ARP
  - **[24:30]** Setting allowance for using ARP
  - **[26:00]** Supplying ARP to Aave (~$60 worth)
  - **[27:00]** Borrowing $20 USDC against the supplied ARP

## Safety and Operation [27:00-29:20]

- Plugin uses ZotModels to validate information
- If insufficient context is provided, the agent asks clarifying questions
- Currently working on additional validation mechanisms for correctness

## Conclusion [29:20-30:20]

- Execution from agents represents the next step in the AI-crypto integration
- Links to the plugin and Compass Labs information available in the description

The demo effectively showcased how the plugin allows for direct DeFi interactions through a conversational interface, eliminating the need for users to understand the underlying technical complexities.
