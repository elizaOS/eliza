---
title: Deploy to Railway
description: One-click deployment to Railway.app
---

## 🚂 Deploy to Railway

Deploy your ElizaOS agent to Railway with one-click deployment for 24/7 operation.

## Prerequisites

- GitHub account
- Railway account (free to start)
- ElizaOS agent working locally
- API keys ready (OpenAI/Anthropic/etc.)

## Step 1: Prepare Your Agent

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
    "start": "elizaos start"
  },
  "dependencies": {
    "@elizaos/cli": "latest"
  }
}
```

**`Procfile`** (optional, for custom commands):

```bash
elizaos start --character characters/my-agent.json
```

## Step 2: Deploy to Railway

### Quick Deploy

1. Go to [railway.app](https://railway.app)
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Connect your GitHub account
5. Select your agent repository
6. Railway will automatically detect and start deployment

### Configure Environment Variables

1. In Railway dashboard, click on your project
2. Go to "Variables" tab
3. Add your environment variables:

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

# Database (Railway provides this automatically)
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

## Step 3: Database Setup

### Option 1: Railway PostgreSQL (Recommended)

1. In your Railway project, click "New"
2. Select "Database" → "Add PostgreSQL"
3. Railway automatically sets `DATABASE_URL`
4. Your agent will use this for persistence

### Option 2: Use PGLite (Default)

If you don't add a database, ElizaOS uses PGLite (local file storage).

**Note**: PGLite data may be lost on redeploy. Use PostgreSQL for persistence.

## Step 4: Domain & Networking

### Custom Domain (Optional)

1. Go to Settings → Domains
2. Add your custom domain
3. Update DNS records as instructed

### Public URL

Railway provides a free subdomain:

- Format: `your-app.up.railway.app`
- HTTPS enabled by default
- Use this URL for webhooks and APIs

## Step 5: Monitoring & Management

### View Logs

1. Click on your deployment
2. Select "View Logs"
3. Monitor for errors or issues

### Restart Your Agent

1. Go to Deployments tab
2. Click "Restart" on current deployment
3. Or trigger new deploy by pushing to GitHub

### Resource Usage

Monitor in Railway dashboard:

- Memory usage
- CPU usage
- Request count
- Estimated monthly cost

## Configuration Tips

### Character File Location

Ensure your character file path is correct:

```json
{
  "scripts": {
    "start": "elizaos start --character characters/agent.json"
  }
}
```

### Port Configuration

Railway automatically sets `PORT` environment variable. ElizaOS handles this automatically.

### Health Checks

Add health endpoint for monitoring:

```javascript
// In your agent configuration
{
  "settings": {
    "healthCheckPath": "/health"
  }
}
```

## Cost Management

### Railway Pricing

- **Starter**: $5/month credit (usually enough for one agent)
- **Pay as you go**: ~$5-20/month typical usage
- **Free tier**: Limited hours available

### Cost Optimization

1. **Use webhooks** instead of polling when possible
2. **Set reasonable intervals** for scheduled tasks
3. **Monitor API usage** to control costs
4. **Use caching** for repeated operations

## Troubleshooting

### Agent Won't Start

**Check logs for errors:**

```
"Cannot find module" → Missing dependency
"API key not found" → Check environment variables
"Port already in use" → Railway handles this automatically
```

**Solutions:**

1. Verify all dependencies in package.json
2. Double-check environment variables
3. Ensure character file path is correct

### Database Connection Issues

If using PostgreSQL:

1. Verify `DATABASE_URL` is set
2. Check if database service is running
3. Try restarting both services

### Memory Issues

If agent crashes with memory errors:

1. Check for memory leaks in plugins
2. Reduce conversation history limit
3. Upgrade to higher Railway plan

### Deployment Fails

Common fixes:

1. Ensure `package.json` has start script
2. Check for syntax errors in character file
3. Verify all required files are committed
4. Check build logs for specific errors

## Advanced Configuration

### Multi-Agent Deployment

Deploy multiple agents in one project:

```json
{
  "scripts": {
    "start": "elizaos start --character characters/agent1.json & elizaos start --character characters/agent2.json --port 3001"
  }
}
```

### Scheduled Tasks

Use Railway cron jobs for scheduled tasks:

1. Go to Settings → Cron
2. Add cron expression
3. Set command to run

### Environment-Specific Configs

Use Railway environments for staging/production:

```javascript
const config = {
  production: {
    logLevel: 'info',
  },
  staging: {
    logLevel: 'debug',
  },
};
```

### Backup Strategy

1. Use PostgreSQL for data persistence
2. Set up regular database backups
3. Export conversation logs periodically

## Security Best Practices

### Environment Variables

- Never commit secrets to GitHub
- Use Railway's variable management
- Rotate API keys regularly
- Use read-only tokens where possible

### Network Security

- Railway provides HTTPS by default
- Use environment-specific URLs
- Implement rate limiting
- Add authentication for admin endpoints

### Access Control

1. Limit GitHub repo access
2. Use Railway team features
3. Enable 2FA on all accounts
4. Monitor access logs

## Next Steps

### After Deployment

1. **Test your live agent** at your Railway URL
2. **Monitor logs** for the first 24 hours
3. **Set up alerts** for errors or downtime
4. **Join community** for deployment tips

### Scaling Up

When ready to scale:

- Add more dynos for higher traffic
- Implement caching layers
- Use CDN for static assets
- Consider microservices architecture

## Support Resources

- **Railway Documentation**: [docs.railway.app](https://docs.railway.app)
- **Railway Community**: [discord.gg/railway](https://discord.gg/railway)
- **ElizaOS Discord**: [discord.gg/elizaos](https://discord.gg/elizaos)
- **Status Page**: [status.railway.app](https://status.railway.app)

---

**🚀 Pro Tip**: Start with minimal configuration and add features gradually. Monitor costs and performance before scaling up.

**⚡ Quick Deploy**: Fork our [example repository](https://github.com/elizaOS/eliza-railway-template) for fastest setup!
