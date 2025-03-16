# CLI

The CLI provides a set of commands to manage your ElizaOS projects and plugins, from local development to cloud deployment.

# TODO: CLI Documentation goes here

## Environment Variables

Create a .env file with your required variables:

```env
ANTHROPIC_API_KEY=your_key
TELEGRAM_BOT_TOKEN=your_token
# Add other required variables
```

# TEE Deployment Docs

## Getting Started

### Prerequisites

- Docker installed and running
- Node.js and npm/bun installed
- A Docker Hub account for publishing images
- A Phala Cloud (https://cloud.phala.network/login) API key for cloud deployments

## Commands

### Building Your Image

Build your Docker image locally:

```bash
elizaos tee phala build \
  -i your-image-name \
  -u your-dockerhub-username \
  -f path/to/Dockerfile \
  -t tag-name
```

### Running the TEE Simulator

Start the local TEE simulator for testing:

```bash
elizaos tee phala simulator
```

This will start the simulator on http://localhost:8090.

### Local Development

You can develop your agent locally in two ways:

1. Build the docker-compose file separately:

```bash
elizaos tee phala build-compose \
  -i your-image-name \
  -u your-dockerhub-username \
  -t tag-name \
  -c path/to/character.json \
  -e path/to/.env \
  -v v2  # or v1 for legacy mode
```

2. Run an existing compose file:

```bash
elizaos tee phala run-local \
  -c path/to/docker-compose.yml \
  -e path/to/.env
```

This separation allows you to:

- Build compose files without running them immediately
- Version control your compose files
- Share compose files with team members
- Run the same compose file multiple times

The CLI will store generated compose files in:

```
.tee-cloud/
  └── compose-files/     # Generated docker-compose files
      └── your-character-tee-compose.yaml
```

### Publishing Your Image

Push your built image to Docker Hub:

```bash
elizaos tee phala publish \
  -i your-image-name \
  -u your-dockerhub-username \
  -t tag-name
```

### List Available Tags

View all tags for your image on Docker Hub:

```bash
elizaos tee phala list-tags \
  -i your-image-name \
  -u your-dockerhub-username
```

### Cloud Deployment

First, set your Phala Cloud API key:

```bash
elizaos tee phala set-apikey your-api-key
```

Deploy to Phala Cloud:

```bash
elizaos tee phala deploy \
  -t phala \
  -m docker-compose \
  -n your-deployment-name \
  -c path/to/docker-compose.yml \
  --env-file path/to/.env
```

### Managing Cloud Deployments

List your active agents (CVMs):

```bash
elizaos tee phala list-cvms
```

List your TEE pods:

```bash
elizaos tee phala teepods
```

List images in a specific TEE pod:

```bash
elizaos tee phala images --teepod-id your-teepod-id
```

Upgrade an existing deployment:

```bash
elizaos tee phala upgrade \
  -t phala \
  -m docker-compose \
  --app-id your-app-id \
  -c path/to/docker-compose.yml \
  --env-file path/to/.env
```

## Directory Structure

The CLI will create the following directory structure:

```
.tee-cloud/
  └── compose-files/     # Generated docker-compose files
```

## Tips

- Use the simulator for local testing before cloud deployment
- Always test your image locally with `run-local` before publishing
- Keep your API keys secure and never commit them to version control
- Use the `--help` flag with any command for detailed usage information

## Troubleshooting

Common issues and solutions:

1. **Docker Build Fails**

   - Ensure Docker daemon is running
   - Check Dockerfile path is correct
   - Verify you have necessary permissions

2. **Simulator Connection Issues**

   - Check if port 8090 is available
   - Ensure Docker has necessary permissions

3. **Cloud Deployment Fails**
   - Verify API key is set correctly
   - Check if image exists on Docker Hub
   - Ensure environment variables are properly set

For more help, use the `--help` flag with any command:

```bash
elizaos tee phala --help
elizaos tee phala <command> --help
```
