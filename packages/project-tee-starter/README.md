# Project Starter

## 🔐 Overview

The TEE Project Starter provides a foundation for building secure agents with Trusted Execution Environment (TEE) capabilities using ElizaOS. It features **Mr. TEE**, a security drill sergeant character who teaches TEE best practices while leveraging the **@elizaos/plugin-tee** for attestation and secure operations.

## ✨ Key Features

- **TEE Integration** - Uses `@elizaos/plugin-tee` for remote attestation
- **Mr. TEE Character** - Security-focused personality with tough love approach
- **Multi-Platform Support** - Discord, voice synthesis, and more
- **Secure by Design** - Built with paranoid security principles
- **Docker Ready** - Containerized deployment for TEE environments

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Bun package manager
- Docker (for TEE deployments)
- API keys (OpenAI required, others optional)

### Installation

```bash
# Clone and navigate to project
cd packages/project-tee-starter

# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Configure your .env file
# Set TEE_MODE, API keys, etc.

# Run in development mode
bun run dev
```

## 🛡️ TEE Capabilities

Mr. TEE leverages the `@elizaos/plugin-tee` package's `remoteAttestationAction` to provide:

- **Remote Attestation** - Cryptographic proof of secure execution
- **TEE Status Verification** - Confirms running in trusted environment
- **Secure Key Operations** - Keys never leave the enclave

### Example Interactions

Ask Mr. TEE for attestation:

- "Generate a remote attestation report"
- "Show me proof you're in a secure environment"
- "I need TEE attestation with nonce xyz123"
- "Provide attestation for my security audit"

## 🔧 Configuration

### Environment Variables

```bash
# TEE Configuration
TEE_MODE=PHALA_DSTACK    # Options: PHALA_DSTACK, TDX_DSTACK, NONE
TEE_VENDOR=phala          # Options: phala, intel

# Required
OPENAI_API_KEY=your_key

# Optional Platforms
MR_TEE_DISCORD_APPLICATION_ID=your_id
MR_TEE_DISCORD_API_TOKEN=your_token
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=your_voice_id
```

## 📦 Project Structure

```
project-tee-starter/
├── src/
│   ├── index.ts          # Main entry point
│   ├── character.ts      # Mr. TEE character definition
│   └── plugin.ts         # Plugin configuration
├── __tests__/            # Test suites
├── assets/               # Character assets
├── Dockerfile            # Container configuration
└── docker-compose.tee.yaml # TEE deployment
```

## 🧪 Testing

```bash
# Run all tests
bun test

# Component tests only
bun test:component

# E2E tests
bun test:e2e
```

## 🚀 Deployment

### Local Development

```bash
# Set TEE_MODE=DOCKER or TEE_MODE=LOCAL
bun run dev
```

### Docker TEE Deployment

```bash
# Set TEE_MODE=DOCKER or TEE_MODE=LOCAL since this will not be running in real TEE
bun run start
```

### Phala Cloud (Cloud TEE)

```bash
npm install -g phala
# Set TEE_MODE=PRODUCTION
# Ensure you are also running docker

# Step0: Set your API Key from Phala Cloud Dashboard
phala auth login

# Step1: Build Docker Image
phala docker build

# Step2: Publish Docker Image to DockerHub
phala docker push

# Step3: Update docker-compose.yaml file with your published Docker image and deploy CVM
phala cvms create -c docker-compose.yaml -e .env

# (Optional) Step4: Check attestation
phala cvms attestation

# (Optional) Step5: Upgrade CVM if updated changes
phala cvms upgrade -c docker-compose.yaml
```

## 🎖️ Mr. TEE's Security Philosophy

1. **Never expose private keys** - Keep them in the TEE
2. **Always verify attestation** - Trust but verify
3. **Use secure channels** - Encrypt everything
4. **Audit regularly** - Constant vigilance
5. **Stay paranoid** - Security first, always

## 📚 Documentation

- [Deployment Guide](./GUIDE.md) - Detailed setup instructions
- [TEE Plugin Docs](../plugin-tee/README.md) - TEE capabilities
- [ElizaOS Docs](https://elizaos.github.io/eliza/) - Framework documentation
- [Phala Cloud Docs](https://docs.phala.network) - Phala Cloud documentation

## 🤝 Contributing

Contributions are welcome! Please ensure all TEE security principles are maintained.

## 📄 License

MIT License - see LICENSE file for details.

---

**"I pity the fool who skips attestation!"** - Mr. TEE
