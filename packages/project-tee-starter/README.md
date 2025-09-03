# Project Starter

## 🔐 Overview

The TEE Project Starter provides a secure foundation for building AI agents with Trusted Execution Environment (TEE) capabilities using ElizaOS. It demonstrates best practices for secure agent deployment with hardware-based security through Phala Cloud's confidential computing infrastructure.

### What You Get

- **Mr. TEE Character** - A security-focused AI personality that teaches TEE concepts with tough love
- **TEE Plugin Integration** - Pre-configured `@elizaos/plugin-tee` for remote attestation and secure operations
- **Multi-Platform Support** - Discord integration, voice synthesis, and extensible to other platforms
- **Production-Ready** - Docker configuration optimized for Phala Cloud TEE deployment
- **Security First** - Built-in paranoid security principles and best practices

## ✨ Key Features

- **TEE Integration** - Uses `@elizaos/plugin-tee` for remote attestation
- **Mr. TEE Character** - Security-focused personality with tough love approach
- **Multi-Platform Support** - Discord, voice synthesis, and more
- **Secure by Design** - Built with paranoid security principles
- **Docker Ready** - Containerized deployment for TEE environments

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Bun package manager (`npm install -g bun`)
- Docker Desktop (for TEE deployments)
- ElizaOS CLI (`npm install -g @elizaos/cli`)
- API Keys:
  - **Required**: OpenAI API key
  - **Optional**: Discord, ElevenLabs, RedPill APIs
  - **For TEE**: Phala Cloud account and API key

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

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic

2. **E2E Tests** (`src/__tests__/e2e/*.e2e.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios including TEE functionality

### Test Structure

```
src/
  __tests__/              # All tests live inside src
    *.test.ts            # Component tests (use Bun test runner)
    e2e/                 # E2E tests (use ElizaOS test runner)
      project-tee-starter.e2e.ts  # E2E test suite with TEE-specific tests
      README.md          # E2E testing documentation
  index.ts               # Export tests here: tests: [ProjectTeeStarterTestSuite]
```

### Running Tests

```bash
# Run all tests (component + e2e)
elizaos test

# Component tests only
elizaos test component

# E2E tests only
elizaos test e2e

# With specific port for E2E tests
elizaos test --port 4000
```

### TEE-Specific Testing

The E2E tests include TEE-specific scenarios:

- TEE service availability checks
- Attestation action registration
- Secure memory operations
- Concurrent secure operations handling

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
# Prerequisites:
# 1. Install the elizaos CLI: npm install -g @elizaos/cli
# 2. Ensure Docker is running and you're logged in via Docker CLI
# 3. Set TEE_MODE=PRODUCTION in your .env file

# Step 1: Login to Phala Cloud (get API key from Phala Cloud Dashboard)
elizaos tee phala auth login

# Step 2: Build Docker Image for TEE deployment [[memory:4308171]]
elizaos tee phala docker build

# Step 3: Push Docker image to DockerHub
elizaos tee phala docker push

# Step 4: Create CVM (Confidential Virtual Machine) instance
elizaos tee phala cvms create -n elizaos-tee -c docker-compose.yaml --vcpu 2 --memory 4192 --disk-size 40 -e .env

# Step 5: Verify attestation (confirms TEE is running securely)
elizaos tee phala cvms attestation

# Step 6: (Optional) Upgrade CVM when you update your code
elizaos tee phala cvms upgrade -c docker-compose.yaml
```

#### Important Notes

- **Docker Requirements**: Ensure Docker Desktop is running and you're authenticated (`docker login`)
- **API Key**: Get your Phala Cloud API key from the [Phala Dashboard](https://dashboard.phala.network)
- **TEE_MODE**: Must be set to `PRODUCTION` for real TEE deployment
- **Resource Allocation**: The example uses 2 vCPUs, 4GB RAM, and 40GB disk - adjust based on your needs

## 🎖️ Mr. TEE's Security Philosophy

1. **Never expose private keys** - Keep them in the TEE
2. **Always verify attestation** - Trust but verify
3. **Use secure channels** - Encrypt everything
4. **Audit regularly** - Constant vigilance
5. **Stay paranoid** - Security first, always

## 📚 Documentation

- [Deployment Guide](./GUIDE.md) - Detailed setup instructions
- [TEE Plugin Implementation](./src/plugin.ts) - TEE capabilities
- [ElizaOS Docs](https://elizaos.github.io/eliza/) - Framework documentation
- [Phala Cloud Docs](https://docs.phala.network) - Phala Cloud documentation

## 🤝 Contributing

Contributions are welcome! Please ensure all TEE security principles are maintained.

## 📄 License

MIT License - see LICENSE file for details.

---

**"I pity the fool who skips attestation!"** - Mr. TEE
