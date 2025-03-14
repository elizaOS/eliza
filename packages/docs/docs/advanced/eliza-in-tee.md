---
sidebar_position: 17
---

# 🫖 Eliza in TEE

![](/img/eliza_in_tee.jpg)

## Overview

The Eliza agent can be deployed in a TEE environment to ensure the security and privacy of the agent's data. This guide will walk you through the process of setting up and running an Eliza agent in a TEE environment by utilizing the TEE Plugin in the Eliza Framework.

### Background

The TEE Plugin in the Eliza Framework is built on top of the [Dstack SDK](https://github.com/Dstack-TEE/dstack), which is designed to simplify the steps for developers to deploy programs to CVM (Confidential VM), and to follow the security best practices by default. The main features include:

- Convert any docker container to a CVM image to deploy on supported TEEs
- Remote Attestation API and a chain-of-trust visualization on Web UI
- Automatic RA-HTTPS wrapping with content addressing domain on 0xABCD.dstack.host
- Decouple the app execution and state persistent from specific hardware with decentralized Root-of-Trust

---

## Core Components

Eliza's TEE implementation consists of two primary providers that handle secure key management operations and remote attestations.

These components work together to provide:

1. Secure key derivation within the TEE
2. Verifiable proof of TEE execution
3. Support for both development (simulator) and production environments

The providers are typically used together, as seen in the wallet key derivation process where each derived key includes an attestation quote to prove it was generated within the TEE environment.

---

### Derive Key Provider

The DeriveKeyProvider enables secure key derivation within TEE environments. It supports:

- Multiple TEE modes:
    - `LOCAL`: Connects to simulator at `localhost:8090` for local development on Mac/Windows
    - `DOCKER`: Connects to simulator via `host.docker.internal:8090` for local development on Linux
    - `PRODUCTION`: Connects to actual TEE environment when deployed to the [TEE Cloud](https://teehouse.vercel.app)

Key features:

- Support to deriveEd25519 (Solana) and ECDSA (EVM) keypairs
- Generates deterministic keys based on a secret salt and agent ID
- Includes remote attestation for each derived key
- Supports raw key derivation for custom use cases

Example usage:

```typescript
const provider = new DeriveKeyProvider(teeMode);
// For Solana
const { keypair, attestation } = await provider.deriveEd25519Keypair(
    secretSalt,
    "solana",
    agentId,
);
// For EVM
const { keypair, attestation } = await provider.deriveEcdsaKeypair(
    secretSalt,
    "evm",
    agentId,
);

// For raw key derivation
const rawKey = await provider.deriveRawKey(
    secretSalt,
    "raw",
);
```

---

### Remote Attestation Provider

The RemoteAttestationProvider handles TEE environment verification and quote generation. It:

- Connects to the same TEE modes as DeriveKeyProvider
- Generates TDX quotes with replay protection (RTMRs)
- Provides attestation data that can be verified by third parties

Key features:

- Generates attestation quotes with custom report data
- Includes timestamp for quote verification
- Supports both simulator and production environments

Example usage:

```typescript
const provider = new RemoteAttestationProvider(teeMode);
const quote = await provider.generateAttestation(reportData);
```

## Tutorial

---

### Prerequisites

Before getting started with Eliza, ensure you have:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Orbstack](https://orbstack.dev/) (Orbstack is recommended)
- For Mac/Windows: Check the prerequisites from [Quickstart Guide](../quickstart.md)
- For Linux: You just need Docker

---

### Environment Setup

To set up your environment for TEE development:

1. **Configure TEE Mode**

    Set the `TEE_MODE` environment variable to one of:

    ```env
    # For Mac/Windows local development
    TEE_MODE=LOCAL

    # For Linux/Docker local development
    TEE_MODE=DOCKER

    # For production deployment
    TEE_MODE=PRODUCTION
    ```

2. **Set Required Environment Variables**

    ```env
    # Required for key derivation
    WALLET_SECRET_SALT=your_secret_salt
    ```

3. **Start the TEE Simulator**

    ```bash
    docker pull phalanetwork/tappd-simulator:latest
    # by default the simulator is available in localhost:8090
    docker run --rm -p 8090:8090 phalanetwork/tappd-simulator:latest
    ```

### Run an Eliza Agent Locally with TEE Simulator

1. **Configure Eliza Agent**

    Go through the [configuration guide](../guides/configuration.md) to set up your Eliza agent.

2. **Start the TEE Simulator**
   Follow the simulator setup instructions above based on your TEE mode.

3. **For Mac/Windows**

    Make sure to set the `TEE_MODE` environment variable to `LOCAL`. Then you can install the dependencies and run the agent locally:

    ```bash
    pnpm i
    pnpm build
    pnpm start --character=./characters/yourcharacter.character.json
    ```

4. **Verify TEE Attestation**

    You can verify the TEE attestation quote by going to the [TEE RA Explorer](https://proof.t16z.com/) and pasting the attestation quote from the agent logs. Here's an example of interacting with the Eliza agent to ask for the agent's wallet address:

    ```bash
    You: what's your wallet address?
    ```

    Log output from the agent:

    ```bash
    Generating attestation for:  {"agentId":"025e0996-69d7-0dce-8189-390e354fd1c1","publicKey":"9yZBmCRRFEBtA3KYokxC24igv1ijFp6tyvzKxRs3khTE"}
    rtmr0: a4a17452e7868f62f77ea2039bd2840e7611a928c26e87541481256f57bfbe3647f596abf6e8f6b5a0e7108acccc6e89
    rtmr1: db6bcc74a3ac251a6398eca56b2fcdc8c00a9a0b36bc6299e06fb4bb766cb9ecc96de7e367c56032c7feff586f9e557e
    rtmr2: 2cbe156e110b0cc4b2418600dfa9fb33fc60b3f04b794ec1b8d154b48f07ba8c001cd31f75ca0d0fb516016552500d07
    rtmr3: eb7110de9956d7b4b1a3397f843b39d92df4caac263f5083e34e3161e4d6686c46c3239e7fbf61241a159d8da6dc6bd1f
    Remote attestation quote:  {
    quote: '0x0400030081000000736940f888442c8ca8cb432d7a87145f9b7aeab1c5d129ce901716a7506375426ea8741ca69be68e92c5df29f539f103eb60ab6780c56953b0d81af523a031617b32d5e8436cceb019177103f4aceedbf114a846baf8e8e2b8e6d3956e96d6b89d94a0f1a366e6c309d77c77c095a13d2d5e2f8e2d7f51ece4ae5ffc5fe8683a37387bfdb9acb8528f37342360abb64ec05ff438f7e4fad73c69a627de245a31168f69823883ed8ba590c454914690946b7b07918ded5b89dc663c70941f8704978b91a24b54d88038c30d20d14d85016a524f7176c7a7cff7233a2a4405da9c31c8569ac3adfe5147bdb92faee0f075b36e8ce794aaf596facd881588167fbcf5a7d059474c1e4abff645bba8a813f3083c5a425fcc88cd706b19494dedc04be2bc3ab1d71b2a062ddf62d0393d8cb421393cccc932a19d43e315a18a10d216aea4a1752cf3f3b0b2fb36bea655822e2b27c6156970d18e345930a4a589e1850fe84277e0913ad863dffb1950fbeb03a4a17452e7868f62f77ea2039bd2840e7611a928c26e87541481256f57bfbe3647f596abf6e8f6b5a0e7108acccc6e89db6bcc74a3ac251a6398eca56b2fcdc8c00a9a0b36bc6299e06fb4bb766cb9ecc96de7e367c56032c7feff586f9e557e2cbe156e110b0cc4b2418600dfa9fb33fc60b3f04b794ec1b8d154b48f07ba8c001cd31f75ca0d0fb516016552500d07eb7110de9956d7b4b1a3397f843b39d92df4caac263f5083e34e3161e4d6686c46c3239e7fbf61241a159d8da6dc6bd13df734883d4d0d78d670a1d17e28ef09dffbbfbd15063b73113cb5bed692d68cc30c38cb9389403fe6a1c32c35dbac75464b77597e27b854839db51dfde0885462020000530678b9eb99d1b9e08a6231ef00055560f7d3345f54ce355da68725bb38cab0caf84757ddb93db87577758bb06de7923c4ee3583453f284c8b377a1ec2ef613491e051c801a63da5cb42b9c12e26679fcf489f3b14bd5e8f551227b09d976975e0fbd68dcdf129110a5ca8ed8d163dafb60e1ec4831d5285a7fbae81d0e39580000dc010000ebb282d5c6aca9053a21814e9d65a1516ebeaacf6fc88503e794d75cfc5682e86aa04e9d6e58346e013c5c1203afc5c72861e2a7052afcdcb3ddcccd102dd0daeb595968edb6a6c513db8e2155fc302eeca7a34c9ba81289d6941c4c813db9bf7bd0981d188ab131e5ae9c4bb831e4243b20edb7829a6a7a9cf0eae1214b450109d990e2c824c2a60a47faf90c24992583bc5c3da3b58bd8830a4f0ad5c650aa08ae0e067d4251d251e56d70972ad901038082ee9340f103fd687ec7d91a9b8b8652b1a2b7befb4cbfdb6863f00142e0b2e67198ddc8ddbe96dc02762d935594394f173114215cb5abcf55b9815eb545683528c990bfae34c34358dbb19dfc1426f56cba12af325d7a2941c0d45d0ea4334155b790554d3829e3be618eb1bfc6f3a06f488bbeb910b33533c6741bff6c8a0ca43eb2417eec5ecc2f50f65c3b40d26174376202915337c7992cdd44471dee7a7b2038605415a7af593fd9066661e594b26f4298baf6d001906aa8fc1c460966fbc17b2c35e0973f613399936173802cf0453a4e7d8487b6113a77947eef190ea8d47ba531ce51abf5166448c24a54de09d671fd57cbd68154f5995aee6c2ccfd6738387cf3ad9f0ad5e8c7d46fb0a0000000000000000000000bd920a00000000000000000000000000',
    timestamp: 1733606453433
    }
    ```

    Take the `quote` field and paste it into the [TEE RA Explorer](https://ra-quote-explorer.vercel.app/) to verify the attestation. **Note**: The verification will be unverified since the quote is generated from the TEE simulator.

    ![](https://i.imgur.com/xYGMeP4.png)

    ![](https://i.imgur.com/BugdNUy.png)

### Build, Test, and Publish an Eliza Agent Docker Image

Now that we have run the Eliza agent in the TEE simulator, we can build and publish an Eliza agent Docker image to prepare for deployment to a real TEE environment.

First, you need to create a Docker account and publish your image to a container registry. Here we will use [Docker Hub](https://hub.docker.com/) as an example.

Login to Docker Hub:

```bash
docker login
```

Build the Docker image:

```bash
# For Linux/AMD64 machines run
docker build -t username/eliza-agent:latest .

# For architecture other than AMD64, run
docker buildx build --platform=linux/amd64 -t username/eliza-agent:latest .
```

For Linux/AMD64 machines, you can now test the agent locally by updating the `TEE_MODE` environment variable to `DOCKER` and setting the environment variables in the [docker-compose.yaml](https://github.com/elizaos/eliza/blob/main/docker-compose.yaml) file. Once you have done that, you can start the agent by running:

> **Note**: Make sure the TEE simulator is running before starting the agent through docker compose.

```bash
docker compose up
```

Publish the Docker image to a container registry:

```bash
docker push username/eliza-agent:latest
```

Now we are ready to deploy the Eliza agent to a real TEE environment.

### Run an Eliza Agent in a Real TEE Environment

Before deploying the Eliza agent to a real TEE environment, you need to create a new TEE account on the [TEE Cloud](https://cloud.phala.network/login). Reach out to Phala Network on [Discord](https://discord.gg/phalanetwork) if you need help.

Next, you will need to take the docker-compose.yaml file in the root folder of the project and edit it based on your agent configuration.

> **Note**: The API Keys and other secret environment variables should be set in your secret environment variables configuration in the TEE Cloud dashboard.

```yaml
# docker-compose.yaml
services:
    tee:
        command:
            [
                "pnpm",
                "start",
                "--character=./characters/yourcharacter.character.json",
            ]
        image: username/eliza-agent:latest
        stdin_open: true
        tty: true
        volumes:
            - /var/run/tappd.sock:/var/run/tappd.sock
            - tee:/app/packages/client-twitter/src/tweetcache
            - tee:/app/db.sqlite
        environment:
            - REDPILL_API_KEY=$REDPILL_API_KEY
            - SMALL_REDPILL_MODEL=anthropic/claude-3-5-sonnet
            - MEDIUM_REDPILL_MODEL=anthropic/claude-3-5-sonnet
            - LARGE_REDPILL_MODEL=anthropic/claude-3-opus
            - ELEVENLABS_XI_API_KEY=$ELEVENLABS_XI_API_KEY
            - ELEVENLABS_MODEL_ID=eleven_multilingual_v2
            - ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
            - ELEVENLABS_VOICE_STABILITY=0.5
            - ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
            - ELEVENLABS_VOICE_STYLE=0.66
            - ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
            - ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
            - ELEVENLABS_OUTPUT_FORMAT=pcm_16000
            - TWITTER_DRY_RUN=false
            - TWITTER_USERNAME=$TWITTER_USERNAME
            - TWITTER_PASSWORD=$TWITTER_PASSWORD
            - TWITTER_EMAIL=$TWITTER_EMAIL
            - X_SERVER_URL=$X_SERVER_URL
            - BIRDEYE_API_KEY=$BIRDEYE_API_KEY
            - SOL_ADDRESS=So11111111111111111111111111111111111111112
            - SLIPPAGE=1
            - SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
            - HELIUS_API_KEY=$HELIUS_API_KEY
            - SERVER_PORT=3000
            - WALLET_SECRET_SALT=$WALLET_SECRET_SALT
            - TEE_MODE=PRODUCTION
        ports:
            - "3000:80"
        restart: always

volumes:
    tee:
```

Now you can deploy the Eliza agent to a real TEE environment. Go to the [TEE Cloud](https://cloud.phala.network/login) and click on the `Create VM` button to configure your Eliza agent deployment.

Click on the `Compose Manifest Mode` tab and paste the docker-compose.yaml file content into the `Compose Manifest` field.

![Compose Manifest](https://i.imgur.com/wl6pddX.png)

Next, go to the `Resources` tab and configure your VM resources.

> **Note**: The `CPU` and `Memory` resources should be greater than the minimum requirements for your agent configuration (Recommended: 2 CPU, 4GB Memory, 50GB Disk).

![Resources](https://i.imgur.com/HsmupO1.png)

Finally, click on the `Submit` button to deploy your Eliza agent.

This will take a few minutes to complete. Once the deployment is complete, you can click on the `View` button to view your Eliza agent.

Here is an example of a deployed agent named `vitalik2077`:

![Deployed Agent](https://i.imgur.com/ie8gpg9.png)

I can go to the dashboard and view the remote attestation info:

![Agent Dashboard](https://i.imgur.com/vUqHGjF.png)

Click on the `Logs` tab to view the agent logs.

![Agent Logs](https://i.imgur.com/aU3i0Dv.png)

Now we can verify the REAL TEE attestation quote by going to the [TEE RA Explorer](https://proof.t16z.com/) and pasting the attestation quote from the agent logs.

![TEE RA Explorer](https://i.imgur.com/TJ5299l.png)

Congratulations! You have successfully run an Eliza agent in a real TEE environment.
