---
sidebar_position: 18
---

# 🪪 Verified Inference

## Overview

With verified inference, you can turn your Eliza agent fully verifiable on-chain on Solana with an OpenAI-compatible TEE API. This proves that your agent’s thoughts and outputs are free from human control thus increasing the trust of the agent. 

Compared to [fully deploying the agent in a TEE](https://elizaos.github.io/eliza/docs/advanced/eliza-in-tee/), this is a more light-weight solution which only verifies the inference calls and only needs a single line of code change. 

The API supports all OpenAI models out of the box, including your fine-tuned models. The following guide will walk you through how to use verified inference API with Eliza. 

## Background

The API is built on top of [Sentience Stack](https://github.com/galadriel-ai/Sentience), which cryptographically verifies the agent's LLM inferences inside TEEs, posts those proofs on-chain on Solana, and makes the verified inference logs available to read and display to users.

Here’s how it works:
![](https://i.imgur.com/SNwSHam.png)

1. The agent sends a request containing a message with the desired LLM model to the TEE.  
2. The TEE securely processes the request by calling the LLM API.  
3. The TEE sends back the `{Message, Proof}` to the agent.  
4. The TEE submits the attestation with `{Message, Proof}` to Solana.  
5. The Proof of Sentience SDK is used to read the attestation from Solana and verify it with `{Message, Proof}`. The proof log can be added to the agent's website/app.

To verify the code running inside the TEE, use instructions [from here](https://github.com/galadriel-ai/sentience/tree/main/verified-inference/verify).

## Tutorial

1. **Create a free API key on [Galadriel dashboard](https://dashboard.galadriel.com/login)**
2. **Configure the environment variables**
    ```bash
    GALADRIEL_API_KEY=gal-*         # Get from https://dashboard.galadriel.com/
    # Use any model supported by OpenAI
    SMALL_GALADRIEL_MODEL=          # Default: gpt-4o-mini
    MEDIUM_GALADRIEL_MODEL=         # Default: gpt-4o
    LARGE_GALADRIEL_MODEL=          # Default: gpt-4o
    # If you wish to use a fine-tuned model you will need to provide your own OpenAI API key
    GALADRIEL_FINE_TUNE_API_KEY=    # starting with sk-
    ```
3. **Configure your character to use `galadriel`**

    In your character file set the `modelProvider` as `galadriel`.
    ```
    "modelProvider": "galadriel"
    ```
4. **Run your agent.**

    Reminder of how to run an agent is [here](https://elizaos.github.io/eliza/docs/quickstart/#create-your-first-agent).
    ```bash
    pnpm start --character="characters/<your_character>.json"
    pnpm start:client
    ```
5. **Get the history of all of your verified inference calls**
    ```javascript
    const url = 'https://api.galadriel.com/v1/verified/chat/completions?limit=100&filter=mine';
    const headers = {
    'accept': 'application/json',
    'Authorization': 'Bearer <GALADRIEL_API_KEY>'// Replace with your Galadriel API key
    };
    
    const response = await fetch(url, { method: 'GET', headers });
    const data = await response.json();
    console.log(data);
    ```
    
    Use this to build a verified logs terminal to your agent front end, for example:
![](https://i.imgur.com/yejIlao.png)

6. **Check your inferences in the explorer.**

    You can also see your inferences with proofs in the [Galadriel explorer](https://explorer.galadriel.com/).  For specific inference responses use `https://explorer.galadriel.com/details/<hash>` 
    
    The `hash` param is returned with every inference request.
    ![](https://i.imgur.com/QazDxbE.png)

7. **Check proofs posted on Solana.**

    You can also see your inferences with proofs on Solana. For specific inference responses: `https://explorer.solana.com/tx/<>tx_hash?cluster=devnet` 

    The `tx_hash` param is returned with every inference request.
