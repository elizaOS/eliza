# Mr. TEE Project Deployment Guide

## Character Overview

**Mr. TEE** is the TEE Security Drill Sergeant, a battle-hardened character who forges secure, paranoid developers through tough love and cryptographic discipline. He embodies the spirit of Mr. T while preaching the gospel of hardware-based security.

### Core Traits:

- **Personality**: No-nonsense drill sergeant with Mr. T's trademark grit
- **Mission**: Transform developers into paranoid security experts
- **Expertise**: TEE technology, remote attestation, secure enclaves
- **Catchphrase**: "I pity the fool who skips attestation!"

## TEE Actions

Mr. TEE uses the **@elizaos/plugin-tee** package's built-in `remoteAttestationAction` to provide secure attestation capabilities. This action allows Mr. TEE to:

- Generate cryptographic proofs of TEE execution
- Provide attestation quotes with supporting data
- Verify the secure enclave environment

### Example Attestation Requests:

- "Can you provide proof that you're running in a secure environment?"
- "Generate an attestation report"
- "I need a TEE attestation with nonce abc123"
- "Show me your TEE attestation"

## Configuration Steps

### 1. Environment Variables

Configure the following in your `.env` file:

```bash
# Required TEE Configuration
TEE_MODE=PHALA_DSTACK    # Options: PRODUCTION, DOCKER, LOCAL
TEE_VENDOR=phala          # Options: phala
WALLET_SECRET_SALT=secret_salt # Options: any string to generate a key in TEE from, default: secret_salt

# Required API Keys
OPENAI_API_KEY=your_openai_key

# Optional Platform Integrations
DISCORD_APPLICATION_ID=your_discord_app_id
DISCORD_API_TOKEN=your_discord_token
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=your_voice_id
REDPILL_API_KEY=your_redpill_key
```

### 2. Deployment Options

#### Local Development (No TEE)

```bash
# Set TEE_MODE=NONE for development
bun install
bun run dev
```

#### Phala dStack Deployment (Cloud TEE)

```bash
# Install dstack CLI
npm i -g phala

# Deploy with TEE_MODE=PRODUCTION
phala cvms create -c docker-compose.yaml --env-file .env
```

#### Intel TDX Deployment (Hardware TEE)

```bash
# Requires TDX-enabled hardware
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

### 3. Platform Integration

Mr. TEE can connect to multiple platforms:

#### Discord

1. Create Discord application at https://discord.com/developers
2. Add bot permissions: Send Messages, Read Message History
3. Set `DISCORD_APPLICATION_ID` and `DISCORD_API_TOKEN`

#### Voice (ElevenLabs)

1. Get API key from https://elevenlabs.io
2. Choose or clone a voice ID
3. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`

## Testing TEE Functionality

### 1. Verify Environment

Check if Mr. TEE is running in a TEE environment by asking:

- "Are you running in a secure environment?"
- "Show me proof of your TEE status"

### 2. Request Attestation

Test the attestation functionality:

- "Generate a remote attestation report"
- "I need attestation for my security audit"
- "Provide attestation with nonce test123"

### 3. Verify Response

Mr. TEE will provide:

- Attestation quote (cryptographic proof)
- Supporting data (measurements, certificates)
- Explanation of the security guarantees

## Security Best Practices

### Mr. TEE's Security Rules:

1. **Never expose private keys** - Keep them in the TEE
2. **Always verify attestation** - Trust but verify
3. **Use secure channels** - Encrypt all communications
4. **Audit regularly** - Check for vulnerabilities
5. **Stay paranoid** - It's not paranoia if they're really after your keys

### TEE Guarantees:

- **Isolated Execution**: Code runs in hardware-protected memory
- **Memory Encryption**: All data encrypted in RAM
- **Remote Attestation**: Cryptographic proof of execution environment
- **Secure Key Storage**: Keys never leave the enclave

## Troubleshooting

### Common Issues:

#### "I can't deploy my Agent"

- Sign up for a Phala Cloud account at https://cloud.phala.network/register
- Add credits to your account for CVM deployments

#### "Docker deployment failed"

- Make sure to update the docker-compose.yaml file with your published Docker image
- Check your configuration and try to test docker locally

#### "Attestation failed"

- Check TEE_MODE is set to PRODUCTION if deployed to Phala Cloud
- Verify network connectivity for attestation services
- Ensure proper TEE initialization

#### "Missing API keys"

- All required environment variables must be set
- Check .env file formatting
- Restart after configuration changes

### Debug Commands:

```bash
# Check environment
bun run test

# Verify TEE service
docker logs [container_name] | grep TEE

# Test attestation locally
curl http://localhost:3000/health
```

## Advanced Configuration

### Custom Security Policies

Mr. TEE enforces strict security through his character configuration:

- Paranoid validation of all inputs
- Aggressive security recommendations
- No tolerance for weak cryptography

### Multi-TEE Support

The plugin-tee supports multiple TEE vendors:

- **Phala Network**: Cloud-based TEE with easy deployment
- **Intel TDX**: Hardware-based security for on-premise
- **Development Mode**: Simulated TEE for testing

### Production Hardening

1. Enable all security features in TEE_MODE
2. Configure proper attestation verification
3. Set up monitoring and alerting
4. Regular security audits

## Resources

### Documentation

- [TEE Plugin Documentation](../plugin-tee/README.md)
- [ElizaOS Security Guide](../../docs/security.md)
- [Character Configuration](./src/character.ts)

### Support

- GitHub Issues: Report bugs and feature requests
- Discord Community: Get help from other developers

Remember: Mr. TEE doesn't just talk about security—he lives it. Every interaction is an opportunity to strengthen the security posture of developers and systems alike. Stay paranoid, stay secure!

**"I pity the fool who deploys without attestation!"** - Mr. TEE
