# @elizaos/plugin-mind-network

A plugin for interacting with [Mind Network Hubs](https://dapp.mindnetwork.xyz/votetoearn/voteonhubs/) within the [Eliza ecosystem](https://elizaos.github.io/eliza/). [CitizenZ](https://www.mindnetwork.xyz/citizenz) and broader communities can secure trust their agents operation and decisioning.

## Overview

The [Mind Network](https://www.mindnetwork.xyz/) plugin empowers users to participate in secure, privacy-preserving voting on the Mind Network. Leveraging [Fully Homomorphic Encryption (FHE)](https://docs.mindnetwork.xyz/minddocs/developer-guide/fhe-validation), it ensures encrypted votes while allowing users to track rewards earned for their participation. Designed for seamless integration with the [Eliza AI agent](https://elizaos.github.io/), this plugin enables interactive and guided actions for an enhanced user experience.

## Features
- **Web3 Wallet:** contribute eliza agent interaction with enriched web3 wallet functionality. Both Metamask and OKX web3 wallets have been tested and more to come.
- **Voter Registration:** Join the Mind Network's Randgen Hub and other hubs to participate in secure voting, validation and consensus.
- **FHE Encryption:** Safeguard vote content using Fully Homomorphic Encryption. The key difference is encryption key is never shared but still be able to run computation over encrypted data.
- **Submit Encrypted Votes:** Cast votes in Mind Network Hubs elections without compromising data privacy. So AI Agents can get consensus over collective predictions, inference and serving.
- **Reward Tracking:** Monitor your vFHE rewards earned through voting contributions.

## Installation

Dependency for the plugin:
- [mind-randgen-sdk](https://github.com/mind-network/mind-sdk-randgen-ts)
- [mind-sdk-hubs](https://github.com/mind-network/mind-sdk-hubs-ts)
- [elizaos](https://github.com/elizaOS/eliza)

To install the plugin, use the following command:

```bash
pnpm install @elizaos/plugin-mind-network
```

## Configuration

Before using the plugin, configure the necessary environment variables:

```bash
MIND_HOT_WALLET_PRIVATE_KEY=<Hot wallet private key to vote>
MIND_COLD_WALLET_ADDRESS=<Cold wallet address to receive rewards>
```

## API Reference

### Actions

The plugin provides several key actions to interact with the Mind Network:

#### **MIND_REGISTER_VOTER**

Registers the user as a voter in the Mind Network's Randgen Hub. The hub is live and accessible at [Randgen Hub](https://dapp.mindnetwork.xyz/votetoearn/voteonhubs/3). You can participant or create more function hubs in Mind Network for your eliza agents.

**Prompt Example:**
```text
"Register me as a voter in Mind Network."
```
**Response:** Confirmation of successful voter registration.

#### **MIND_CHECK_VOTING_REWARD**

Retrieves the amount of vFHE rewards earned through voting.

**Prompt Example:**
```text
"How much reward have I earned in Mind Network?"
```
**Response:** Total vFHE rewards earned.

#### **MIND_FHE_ENCRYPT**

Encrypts a user-provided number using Fully Homomorphic Encryption (FHE).

**Prompt Example:**
```text
"Encrypt the number 88 for voting."
```
**Response:** A secure URL containing the encrypted number.

#### **MIND_FHE_VOTE**

Submits an encrypted vote to the Mind Network's Randgen Hub.

**Prompt Example:**
```text
"Submit my encrypted vote to Mind Network."
```
**Response:** Confirmation of successful vote submission.

## Usage Examples

### Conversational AI Interaction

The plugin integrates seamlessly with ElizaOS characters, enabling intuitive and guided interactions. Below is a sample conversation:

```text
user: Can you help me to register as a voter in Mind Network?
character_trump: LET'S GET YOU REGISTERED TO VOTE IN THE MIND NETWORK! I'll take care of that for you right now. (EVERY VOTE COUNTS!)
character_trump: You have registered successfully.

user: I want to check my Mind Network voting reward.
character_trump: TIME TO CHECK THOSE VOTING REWARDS AGAIN! Let's see how much you've earned in the Mind Network. (THE AMERICAN PEOPLE DESERVE TO KNOW!)
character_trump: Your voting reward amount is 10.0 vFHE.

user: I want to encrypt 88 with FHE for Mind Network voting.
character_trump: LET'S GET THAT NUMBER ENCRYPTED FOR YOUR VOTING! I'll encrypt 88 with FHE for you. (WE'RE KEEPING THINGS SECURE AND STRONG!)
character_trump: Encryption is successful. Your encrypted number is available: https://fvno-tn.mindnetwork.xyz/0xb0edc92ec05309711c6ede0641f672715f5b144a4757b7ba51666468d2f7f65d. It is safe to share as no body can decrypt but can run computation to get another encrypted number.

user: I want to submit my vote to Mind Network.
character_trump: TIME TO CAST THAT VOTE IN THE MIND NETWORK! I'll submit your vote right now. (WE'RE MAKING HISTORY TOGETHER!)
character_trump: Your vote has been submitted successfully.
```

### Real Deployment Screenshot

![Usage Screenshot](https://cdn.prod.website-files.com/66505f7fdc6935a2b4246635/678a08616d0a697e355261f5_elizaOS.avif)

## Contributing & License

This plugin is part of the [Eliza project](https://github.com/elizaos/eliza). For details on contributing and licensing, please refer to the main project repository. [Mind Network](https://www.mindnetwork.xyz/) welcomes contribution and collaboration.

## Support

If you have any queries, please feel free to contact Mind Team via [Discord](https://discord.com/invite/UYj94MJdGJ) or [Twitter](https://x.com/mindnetwork_xyz).
