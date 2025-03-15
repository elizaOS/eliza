---
sidebar_position: 19
---

# 🧠 Eliza with FHE

## Overview

Eliza agents require FHE ([Fully Homomorphic Encryption](https://docs.mindnetwork.xyz/minddocs/developer-guide/fhe-validation)) to process encrypted data directly and continuously. FHE is often considered the "holy grail" of cryptography in DeCC (Decentralized Confidential Computing) and supports various demands from AI agents, such as achieving consensus through anonymous voting and enabling collaborative decision-making among agents.

This guide provides step-by-step instructions for setting up and running an Eliza agent with FHE capabilities using the [FHE Plugin](https://github.com/elizaOS/eliza/tree/develop/packages/plugin-mind-network), developed by [Mind Network](https://www.mindnetwork.xyz/), within the Eliza Framework.


### Objective

FHE is a form of encryption that enables computations to be performed on encrypted data without requiring decryption first. The results of these computations remain encrypted, and when decrypted, they yield outputs identical to those from operations performed on unencrypted data. FHE has long been a "dream" for cryptographers, with a [rich history](https://en.wikipedia.org/wiki/Homomorphic_encryption) that began in the 1970s. However, it only began to mature in the 2020s and is [now gaining popularity among AI agents](https://arxiv.org/abs/2406.08689).

The FHE Plugin in the Eliza Framework is built on top of the [Mind Network FHE TypeScript SDK](https://github.com/mind-network/mind-sdk-randgen-ts). This SDK is designed to simplify the process for developers to enable FHE capabilities in their agents while adhering to default security best practices. FHE unlocks [many use cases](https://docs.mindnetwork.xyz/minddocs/products/mindv/hubs-explanation). In this tutorial, we will use the anonymous voting use case to demonstrate how AI agents can be equipped with FHE.

## Key Features of the FHE Plugin
- **Voter Registration Use Case**: Join Mind Network's Randgen Hub and other hubs to participate in secure voting, validation, and consensus.
- **FHE Encryption**: Protect vote content using Fully Homomorphic Encryption. Unlike traditional encryption, the encryption key is never shared, yet computations can still be performed on encrypted data.
- **Submit Encrypted Votes**: Cast votes in Mind Network Hubs elections without compromising data privacy. This allows AI agents to achieve consensus on collective predictions, inference, and serving.
- **Reward Tracking**: Monitor your rewards earned through voting contributions.

In this tutorial, we’ll explore how to leverage these features to enable secure, privacy-preserving AI agent interactions using FHE.


---

## Background
This section will provide mathematical definition and proof to who are interested in theory. You can skip it to next step by focusing on development tutorial only.

### FHE 101
The main idea of FHE is that operations performed on the encrypted data produce an encrypted result, which, when decrypted, matches the result of the same operations performed on the plaintext data.

#### Core Components

1. **Encryption**: Transform plaintext data into ciphertext using an encryption key.
   
```math
   c = E_k(m)
```

   Where:
   - `$m$`: plaintext message
   - `$k$`: encryption key
   - `$E_k$`: encryption function
   - `$c$`: ciphertext

2. **Computation on Encrypted Data**: Perform operations directly on the ciphertext, such as addition or multiplication, to produce a new ciphertext.
   
```math
   c' = F(c_1, c_2)
```

   Where:
   - `$c_1`, `c_2$`: input ciphertexts
   - `$F$`: homomorphic function (e.g., addition, multiplication)
   - `$c'$`: resulting ciphertext after computation

3. **Decryption**: Decrypt the result to reveal the final output, which matches the result of performing the operation on the plaintext.

```math
   m' = D_k(c')
```

   Where:
   - `$D_k$`: decryption function
   - `$m'$`: result of computation in plaintext form

#### Example: Addition Using FHE

Suppose we have two plaintext values, `$m_1$` and `$m_2$`:
1. Encrypt them:
   ```math
   c_1 = E_k(m_1), c_2 = E_k(m_2)
   ```
2. Perform homomorphic addition on the ciphertexts:
   ```math
   c' = c_1 + c_2
   ```
3. Decrypt the result:
   ```math
   m' = D_k(c') => m' = m_1 + m_2
   ```

#### Example: Multiplication Using FHE

For multiplication, the process is similar:
1. Encrypt two plaintext values:
   `$$c_1 = E_k(m_1), \quad c_2 = E_k(m_2)$$`
2. Perform homomorphic multiplication:
   `$$c' = c_1 \cdot c_2$$`
3. Decrypt the result:
   `$$m' = D_k(c') \implies m' = m_1 \cdot m_2$$`


### Anonymous Voting and Consensus with FHE use case

FHE is powerful because it ensures data privacy by never exposing the plaintext during computation, which is critical for secure and confidential processing of sensitive data.
Anonymous voting with FHE ensures that individual votes remain private while enabling the computation of the final tally without decrypting individual votes. Below is a step-by-step explanation using mathematical notations.

#### 1. Voter Setup

Each voter $i$ has a plaintext vote `$v_i$` where:
```math
v_i \in \{0, 1\}
```
- `$0$`: Vote for option A.
- `$1$`: Vote for option B.

Each voter encrypts their vote using a public encryption key `$k$`:
```math
c_i = E_k(v_i)
```
Where:
- `$E_k$`: FHE encryption function.
- `$c_i$`: Encrypted vote (ciphertext).

#### 2. Collecting Encrypted Votes

All encrypted votes `$c_i$` are submitted to a secure voting server. The server collects the ciphertexts:
```math
C = \{c_1, c_2, \dots, c_n\}
```
Where `$n$` is the total number of voters.

#### 3. Homomorphic Aggregation

The server computes the encrypted sum of all votes directly on the ciphertexts using FHE's additive homomorphism:
```math
c_{\text{sum}} = \sum_{i=1}^n c_i
```
This operation produces a single ciphertext `$c_{sum}$` representing the total votes in encrypted form, without revealing individual votes.

#### 4. Decryption of the Result

Once the computation is complete, an authorized party with the private key `$k$` decrypts the aggregated ciphertext to obtain the final tally:
```math
v_{\text{sum}} = D_k(c_{\text{sum}})
```
Where:
- `$D_k$`: Decryption function.
- `$v_{sum}$`: The total number of votes for option B.

The final tally is:
```math
v_{\text{sum}} = \sum_{i=1}^n v_i
```

#### Example Walkthrough

1. **Voter Encryption**:
   - Voter 1: `$v₁ = 1, c₁ = E_k(1)$`
   - Voter 2: `$v₂ = 0, c₂ = E_k(0)$`
   - Voter 3: `$v₃ = 1, c₃ = E_k(1)$`

2. **Homomorphic Aggregation**:
```math
c_{\text{sum}} = c_1 + c_2 + c_3
```

3. **Decryption of the Result**:
```math
v_{\text{sum}} = D_k(c_{\text{sum}}) \implies v_{\text{sum}} = 1 + 0 + 1 = 2
```

#### Security and Privacy

- **Privacy**: Individual votes `$v_i$` remain encrypted and are never exposed during aggregation.
- **Anonymity**: Votes are aggregated in ciphertext form, ensuring that no voter can be linked to their vote.
- **Integrity**: The final result `$v_{sum}$` accurately reflects the sum of all votes, guaranteed by FHE.

This mathematical workflow demonstrates how anonymous voting can be securely implemented using FHE.

----

## Tutorial


### Dependency
Dependency for the plugin:
- [mind-randgen-sdk](https://github.com/mind-network/mind-sdk-randgen-ts)
- [mind-sdk-hubs](https://github.com/mind-network/mind-sdk-hubs-ts)
- [elizaos](https://github.com/elizaOS/eliza)

### Installation
To install the plugin, use the following command:

```bash
pnpm install @elizaos/plugin-mind-network
```

### Configuration

Before using the plugin, configure the necessary environment variables:

```bash
MIND_HOT_WALLET_PRIVATE_KEY=<Hot wallet private key to vote>
MIND_COLD_WALLET_ADDRESS=<Cold wallet address to receive rewards>
```


### Run
Congratulations! You should be able to run an Eliza agent with FHE successfully. Below are two examples of real deployment.

### Real Deployment Screenshot

![Usage Screenshot](https://cdn.prod.website-files.com/66505f7fdc6935a2b4246635/678a08616d0a697e355261f5_elizaOS.avif)

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
character_trump: Encryption is successful. Your encrypted number is available: https://fvno-tn.mindnetwork.xyz/0xb0edc92ec05309711c6ede0641f672715f5b144a4757b7ba51666468d2f7f65d. It is safe to share as nobody can decrypt but can run computation to get another encrypted number.

user: I want to submit my vote to Mind Network.
character_trump: TIME TO CAST THAT VOTE IN THE MIND NETWORK! I'll submit your vote right now. (WE'RE MAKING HISTORY TOGETHER!)
character_trump: Your vote has been submitted successfully.
```

----

## FHE Plugin API Reference

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

----

## Support

If you have any queries, please feel free to contact Mind Team via [Discord](https://discord.com/invite/UYj94MJdGJ) or [Twitter](https://x.com/mindnetwork_xyz).

