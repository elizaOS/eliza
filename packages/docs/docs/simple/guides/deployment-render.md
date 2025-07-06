---
title: Deploy to Render
description: Free and paid deployment options on Render.com
---

## 🎨 Deploy to Render

Deploy your ElizaOS agent to Render with automatic GitHub deployments and free tier options.

## Prerequisites

- GitHub account
- Render account (free)
- ElizaOS agent working locally
- API keys ready (OpenAI/Anthropic/etc.)

## Step 1: Prepare Your Repository

### Create a GitHub Repository

1. Create a new repository on GitHub
2. Push your agent code:

```bash
cd your-agent-folder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Add Required Files

Ensure your repository has:

**`package.json`** with start script:

```json
{
  "name": "my-elizaos-agent",
  "version": "1.0.0",
  "scripts": {
    "start": "elizaos start",
    "build": "echo 'No build required'"
  },
  "dependencies": {
    "@elizaos/cli": "latest"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

**`render.yaml`** (optional, for Infrastructure as Code):

```yaml
services:
  - type: web
    name: my-elizaos-agent
    runtime: node
    buildCommand: bun install
    startCommand: bun start
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: elizaos-db
          property: connectionString

databases:
  - name: elizaos-db
    plan: free
    databaseName: elizaos
    user: elizaos
```

## Step 2: Deploy to Render

### Create New Web Service

1. Go to [render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Connect your GitHub account
4. Select your repository
5. Configure service settings:
   - **Name**: your-agent-name
   - **Runtime**: Node
   - **Branch**: main
   - **Build Command**: `bun install`
   - **Start Command**: `bun start`

### Configure Environment Variables

In the Render dashboard, add environment variables:

```bash
# Required - AI Provider (choose one)
OPENAI_API_KEY=sk-your-openai-key
# OR
ANTHROPIC_API_KEY=your-anthropic-key

# Optional - Platform Integrations
DISCORD_APPLICATION_ID=your-discord-app-id
DISCORD_API_TOKEN=your-discord-bot-token
TELEGRAM_BOT_TOKEN=your-telegram-token
TWITTER_API_KEY=your-twitter-api-key
TWITTER_API_SECRET=your-twitter-secret
TWITTER_ACCESS_TOKEN=your-access-token
TWITTER_ACCESS_SECRET=your-access-secret

# Database (if using PostgreSQL)
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

## Step 3: Database Options

### Option 1: Render PostgreSQL

1. Click "New +" → "PostgreSQL"
2. Configure database:
   - **Name**: elizaos-db
   - **Database**: elizaos
   - **User**: elizaos
   - **Plan**: Free (limited to 90 days) or Starter ($7/month)
3. Copy connection string to `DATABASE_URL`

### Option 2: External Database

Use any PostgreSQL provider:

- Supabase (free tier)
- Neon (free tier)
- ElephantSQL (free tier)

### Option 3: PGLite (Default)

No configuration needed - uses local file storage.

**Note**: Data may be lost on redeploy with free tier.

## Step 4: Deploy Configuration

### Free Tier Limitations

- **Spins down after 15 minutes** of inactivity
- **750 hours/month** (enough for one service)
- **Limited CPU and RAM**
- **No persistent disk** (use external database)

### Keeping Service Active

For 24/7 availability on free tier:

1. Use external monitoring service (UptimeRobot, Pingdom)
2. Set up health check endpoint
3. Ping your service every 14 minutes

Add health endpoint to your agent:

```javascript
// In your configuration
{
  "settings": {
    "port": process.env.PORT || 10000,
    "healthCheckPath": "/health"
  }
}
```

## Step 5: Custom Domain

### Add Custom Domain

1. Go to Settings → Custom Domains
2. Add your domain
3. Update DNS records:
   - **Type**: CNAME
   - **Name**: your-subdomain
   - **Value**: your-app.onrender.com

### SSL Certificate

Render provides free SSL certificates automatically.

## Deployment Tips

### Auto-Deploy Setup

1. Enable auto-deploy in Settings
2. Every push to main branch triggers deployment
3. Set up branch protection for production

### Environment Management

Create separate services for staging/production:

```yaml
# render-staging.yaml
services:
  - type: web
    name: my-agent-staging
    branch: develop
    envVars:
      - key: NODE_ENV
        value: staging

# render-production.yaml
services:
  - type: web
    name: my-agent-production
    branch: main
    envVars:
      - key: NODE_ENV
        value: production
```

### Build Optimization

Speed up deployments:

```json
{
  "scripts": {
    "postinstall": "echo 'Skipping postinstall'",
    "build": "echo 'No build step required'"
  }
}
```

## Monitoring & Logs

### View Logs

1. Go to your service dashboard
2. Click "Logs" tab
3. Filter by:
   - Deploy logs
   - Service logs
   - Time range

### Set Up Alerts

1. Go to Settings → Notifications
2. Configure alerts for:
   - Deploy failures
   - Service failures
   - High resource usage

### Performance Monitoring

Monitor in dashboard:

- CPU usage
- Memory usage
- Response times
- Request count

## Troubleshooting

### Service Won't Start

**Check for common issues:**

```
"Error: Cannot find module" → Missing dependency
"EADDRINUSE" → Port conflict (use PORT env var)
"API key not found" → Check environment variables
```

**Solutions:**

1. Verify package.json dependencies
2. Use `process.env.PORT` for port binding
3. Double-check environment variables
4. Check build and deploy logs

### Slow Cold Starts

Free tier services spin down after inactivity:

1. First request takes 30-60 seconds
2. Use health check pings to keep active
3. Upgrade to paid tier for always-on

### Database Connection Issues

If using Render PostgreSQL:

1. Check connection string format
2. Verify database is running
3. Check connection pool settings
4. Review database logs

### Memory Limits

Free tier has 512MB RAM limit:

1. Optimize agent memory usage
2. Reduce conversation history
3. Limit concurrent connections
4. Upgrade to paid tier if needed

## Scaling & Optimization

### Upgrade Options

When to upgrade from free tier:

- Need 24/7 availability without delays
- More than 750 hours/month usage
- Require persistent disk storage
- Need more CPU/RAM

### Performance Tips

1. **Enable caching** for repeated queries
2. **Optimize dependencies** - remove unused packages
3. **Use connection pooling** for database
4. **Implement rate limiting** to prevent abuse

### Cost Optimization

Render pricing tiers:

- **Free**: $0/month (limited features)
- **Starter**: $7/month (always-on, 512MB RAM)
- **Standard**: $25/month (1GB RAM, autoscaling)
- **Pro**: $85/month (4GB RAM, priority support)

## Security Best Practices

### Environment Variables

- Never commit secrets to GitHub
- Use Render's secret management
- Rotate API keys regularly
- Use different keys for staging/production

### Network Security

- Enable force HTTPS
- Set up CORS properly
- Use rate limiting
- Implement request validation

### Access Control

1. Use GitHub branch protection
2. Enable 2FA on all accounts
3. Limit deploy permissions
4. Monitor access logs

## Support Resources

- **Render Documentation**: [docs.render.com](https://docs.render.com)
- **Render Community**: [community.render.com](https://community.render.com)
- **ElizaOS Discord**: [discord.gg/elizaos](https://discord.gg/elizaos)
- **Status Page**: [status.render.com](https://status.render.com)

---

**💡 Pro Tip**: Start with the free tier to test your deployment, then upgrade once you've validated your agent works well in production.

**🚀 Quick Start**: Use our [render.yaml template](https://github.com/elizaOS/eliza-render-template) for fastest setup!
