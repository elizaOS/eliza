# Railway Deployment Guide for Eliza

This guide will help you deploy the Eliza project to Railway with PostgreSQL database support using a streamlined Docker configuration.

## Prerequisites

1. A Railway account (sign up at https://railway.app)
2. GitHub account connected to Railway
3. API keys for OpenAI and/or OpenRouter
4. Discord application credentials (if using Discord integration)

## Deployment Steps

### 1. Fork or Push the Repository

Ensure your repository includes the following Railway configuration files:

- `railway.json` or `railway.toml` - Railway configuration
- `Dockerfile.railway` - Railway-specific Dockerfile
- `.railwayignore` - Excludes unnecessary files from deployment

### 2. File Exclusion Setup

The `.railwayignore` file automatically excludes:

- Other Docker files (`Dockerfile`, `Dockerfile.docs`, `docker-compose.yaml`, etc.)
- Development and test files
- Documentation files (except README.md)
- Build artifacts and cache directories
- OS-generated files

This ensures only Railway-specific files are deployed, reducing build time and potential conflicts.

### 3. Create a New Project on Railway

1. Log in to Railway
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository
5. Railway will automatically detect and use `Dockerfile.railway`

### 4. Add PostgreSQL Database

1. In your Railway project, click "New"
2. Select "Database" → "Add PostgreSQL"
3. Wait for the database to deploy

### 5. Configure Environment Variables

In your Railway project settings, add the following environment variables:

#### Required Variables:

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# OpenRouter Configuration
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Embedding Configuration
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

# Text Generation Configuration
TEXT_PROVIDER=openrouter
TEXT_MODEL=google/gemini-2.5-flash-preview-05-20

# Knowledge Base Configuration
CTX_KNOWLEDGE_ENABLED=true
LOAD_DOCS_ON_STARTUP=true

# Database URL (Reference Railway's PostgreSQL)
POSTGRES_URL=${{Postgres.DATABASE_URL}}

# Server Configuration
LOG_LEVEL=debug
```

#### Optional Variables:

```bash
# Discord Integration (if using Discord bot)
DISCORD_APPLICATION_ID=your_discord_app_id
DISCORD_API_TOKEN=your_discord_bot_token

# Additional API Keys (if needed)
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# EVM Chains (if using blockchain features)
EVM_CHAINS=

# Birdeye API (if using Solana features)
BIRDEYE_API_KEY=
```

### 6. Deploy the Application

1. Railway will automatically detect the `railway.json`/`railway.toml` configuration
2. It will use `Dockerfile.railway` for the build process (ignoring other Docker files)
3. The deployment will start automatically
4. Files listed in `.railwayignore` will be excluded from the build

### 7. Access Your Application

Once deployed:

1. Go to your service settings
2. Under "Networking", generate a domain
3. Your app will be available at the generated URL

## Configuration Details

### railway.json/railway.toml

This file configures:

- Uses custom Dockerfile (`Dockerfile.railway`)
- Sets the start command to run elizaos from project-starter
- Configures health checks and restart policies
- Sets production environment variables

### Dockerfile.railway

This Dockerfile:

- Uses Node.js 23.3.0 slim image
- Installs all required dependencies (bun, turbo, ffmpeg, etc.)
- Builds the entire project
- Installs elizaos CLI globally
- Changes to the project-starter directory
- Runs elizaos with debug logging

### .railwayignore

This file excludes:

- All other Docker files and docker-compose files
- Development and test files
- Documentation and build artifacts
- OS-generated and editor files
- Package manager lock files (Railway generates its own)

## Environment Variables Explained

- **OPENAI_API_KEY**: Required for OpenAI services (embeddings, completions)
- **OPENROUTER_API_KEY**: Required for OpenRouter text generation
- **EMBEDDING_PROVIDER**: Specifies which service to use for embeddings (e.g., "openai")
- **TEXT_EMBEDDING_MODEL**: The specific embedding model to use
- **EMBEDDING_DIMENSION**: Dimension of the embedding vectors (1536 for text-embedding-3-small)
- **TEXT_PROVIDER**: Specifies which service to use for text generation (e.g., "openrouter")
- **TEXT_MODEL**: The specific text generation model to use
- **CTX_KNOWLEDGE_ENABLED**: Enable/disable context knowledge features
- **LOAD_DOCS_ON_STARTUP**: Whether to load documentation on startup
- **POSTGRES_URL**: Database connection string (automatically provided by Railway)

## Troubleshooting

### Database Connection Issues

- Ensure the POSTGRES_URL is properly referenced using `${{Postgres.DATABASE_URL}}`
- Check that your PostgreSQL service is running in Railway

### Build Failures

- Check the build logs in Railway
- Ensure all dependencies are properly specified
- Verify that the Dockerfile.railway is in the root directory
- Check that .railwayignore isn't excluding necessary files

### Runtime Errors

- Check the deployment logs
- Verify all required environment variables are set
- Ensure the elizaos CLI is properly installed

### File Conflicts

- The .railwayignore file prevents conflicts with other Docker files
- If you need to include a file that's being ignored, add `!filename` to .railwayignore

## Monitoring

- Use Railway's built-in logging to monitor your application
- Set up alerts for deployment failures
- Monitor database usage and performance

## Scaling

Railway automatically handles:

- Horizontal scaling based on traffic
- Database connection pooling
- SSL certificates

## Cost Considerations

- Railway charges based on usage
- Monitor your resource consumption
- Consider upgrading to a higher plan for production use
- The .railwayignore file helps reduce build times and costs

## Support

For issues specific to:

- Railway platform: https://docs.railway.app
- Eliza framework: Check the project documentation
- This deployment: Review the logs and configuration files

## Quick Deployment Checklist

1. ✅ Repository contains `railway.json` or `railway.toml`
2. ✅ Repository contains `Dockerfile.railway`
3. ✅ Repository contains `.railwayignore`
4. ✅ PostgreSQL database added to Railway project
5. ✅ Environment variables configured
6. ✅ Domain generated for public access

With this setup, you can simply push your repository to GitHub and Railway will handle the rest, using only the Railway-specific configuration and ignoring all other Docker files.
