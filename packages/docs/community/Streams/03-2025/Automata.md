---
title: OneRPC (Automata) Plugin Tutorial - Verifiable RPC Relay for AI Agents
description: An in-depth look at OneRPC, a verifiable RPC relay for AI agents featuring trusted execution modules and DCAP plugin, presented by Automata.
keywords: [eliza-os, plugin-tutorial, rpc-relay, tee, blockchain, privacy]
date: 2025-03-27
---

# Summary of OneRPC Presentation by Gideon from Automata

<div className="responsive-iframe">
  <iframe
    src="https://www.youtube.com/embed/4eqAeRyAeXc"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowFullScreen
  />
</div>

- Date: 2025-03-27
- YouTube Link: https://www.youtube.com/watch?v=4eqAeRyAeXc

## Key Points and Timestamps

**Introduction and Overview [0:00-3:00]**

- OneRPC is presented as a verifiable RPC relay for AI agents with trusted execution modules and DCAP plugin
- Automata is described as a machine attestation layer that verifies machine authenticity on-chain using TEE attestations

**Problem Statement [4:36-7:45]**

- AI agents currently run on opaque systems with multiple trust assumptions
- Users cannot verify what's happening behind the scenes with AI models

**Trusted Execution Environments (TEEs) [7:45-11:20]**

- TEEs are secure enclaves that securely execute code and process data
- Unauthorized parties cannot access or modify code/data running inside
- Remote attestation allows verification that a legitimate TEE is running

**DCAP Plugin for ELIZA OS [11:20-13:30]**

- Posts remote attestation reports on-chain for transparent verification
- Supports Intel SGX and TDX
- Added to the ELIZA plugin repository

**OneRPC Approaches [13:30-24:30]**

1. **Verifiable AI Relay [13:30-17:55]**

   - Started as a Web3 relay (mentioned by Vitalik)
   - Ensures users are interacting with the correct AI model
   - Removes sensitive data from request headers and masks personal info
   - Prevents LLM providers from linking requests to specific users

2. **Verifiable AI Sub-Agents [17:55-24:30]**
   - Decouples decision-making (LLM's role) from execution
   - Execution modules run inside TEE to provide verifiable actions
   - Enforces policies without suppressing the LLM's creative thought process
   - Enables auditability even for closed-source models
   - Modular approach allows integration with any agent

**Demo [24:30-33:55]**

- Demonstration of a Twitter sub-agent that can post verifiable tweets
- Shows the attestation process that verifies the agent is running expected code
- Demonstrates the full workflow from setup to verification

**Conclusion [33:55-35:20]**

- Invitation to join weekly discussions at 1rpc.ai
- Recognition of the importance of verifiable agent actions for real-world applications

The presentation highlights how OneRPC addresses the critical challenge of trust in AI systems through TEE technology, enabling both privacy and verifiability for AI agent interactions.
