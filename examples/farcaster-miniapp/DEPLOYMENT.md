# 🚀 Deployment Guide

Complete guide for deploying Spartan Multi-Chain Mini App to production.

## Table of Contents
- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Environment Setup](#environment-setup)
- [Build Process](#build-process)
- [Deployment Options](#deployment-options)
  - [Vercel](#vercel)
  - [Railway](#railway)
  - [Fly.io](#flyio)
  - [AWS/DigitalOcean](#awsdigitalocean)
- [Post-Deployment](#post-deployment)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Pre-Deployment Checklist

### Security ✅
- [ ] All private keys stored securely (not in code)
- [ ] Environment variables configured properly
- [ ] CORS settings restricted to your domain
- [ ] HTTPS enabled (required for Farcaster)
- [ ] Rate limiting configured
- [ ] API keys rotated from development

### Configuration ✅
- [ ] Production RPC endpoints configured
- [ ] Database setup (if using persistent storage)
- [ ] Domain name registered
- [ ] SSL certificate obtained
- [ ] Monitoring tools set up

### Testing ✅
- [ ] All features tested on testnet
- [ ] Production build tested locally
- [ ] Security audit completed
- [ ] Performance testing done
- [ ] Error tracking configured

## Environment Setup

### Production Environment Variables

Create a `.env.production` file:

```env
# Server Configuration
PORT=3001
HOSTNAME=your-domain.com
NODE_ENV=production

# ElizaOS API (your production instance)
ELIZA_API_URL=https://your-eliza-api.com

# Solana Configuration
SOLANA_RPC_URL=https://your-premium-rpc.com
SOLANA_PRIVATE_KEY=<use_secret_manager>

# EVM Configuration
EVM_PRIVATE_KEY=<use_secret_manager>
EVM_PROVIDER_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY
ETHEREUM_PROVIDER_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR-KEY
ETHEREUM_PROVIDER_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/YOUR-KEY
ETHEREUM_PROVIDER_OPTIMISM=https://opt-mainnet.g.alchemy.com/v2/YOUR-KEY

# LiFi Integration (recommended for production)
LIFI_API_KEY=your_production_lifi_key

# Farcaster Integration
FARCASTER_FID=your_fid
FARCASTER_NEYNAR_API_KEY=your_production_key
FARCASTER_SIGNER_UUID=your_signer_uuid

# Wallet Mappings (use database in production)
# Or use a secure key-value store
```

### Secrets Management

**Recommended Approach:**

1. **Use a secrets manager:**
   - AWS Secrets Manager
   - HashiCorp Vault
   - Vercel/Railway environment variables
   - Doppler

2. **Never commit secrets:**
   - Add `.env*` to `.gitignore`
   - Use environment variable injection
   - Rotate keys regularly

## Build Process

### 1. Build Frontend

```bash
npm run build
```

This creates an optimized production build in `dist/`:
- Minified JavaScript bundles
- Optimized CSS
- Compressed assets
- Source maps (optional)

### 2. Test Production Build Locally

```bash
npm run preview
npm start
```

Access at `http://localhost:3000` and verify all features work.

### 3. Build Optimization

**package.json optimization:**
```json
{
  "scripts": {
    "build": "tsc && vite build --mode production",
    "build:analyze": "vite build --mode production && vite-bundle-visualizer"
  }
}
```

## Deployment Options

### Vercel

**Best for:** Quick deployment with automatic HTTPS

#### Steps:

1. **Install Vercel CLI:**
```bash
npm install -g vercel
```

2. **Login:**
```bash
vercel login
```

3. **Deploy:**
```bash
vercel --prod
```

4. **Configure:**
   - Add environment variables in Vercel dashboard
   - Set build command: `npm run build`
   - Set output directory: `dist`
   - Configure serverless functions for backend

#### vercel.json Configuration:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    },
    {
      "src": "package.json",
      "use": "@vercel/static-build",
      "config": {
        "distDir": "dist"
      }
    }
  ],
  "routes": [
    {
      "src": "/api/(.*)",
      "dest": "server.js"
    },
    {
      "src": "/(.*)",
      "dest": "/dist/$1"
    }
  ]
}
```

### Railway

**Best for:** Full-stack deployment with database

#### Steps:

1. **Connect GitHub:**
   - Go to railway.app
   - Connect your repository

2. **Configure Service:**
   - Add environment variables
   - Set build command: `npm run build`
   - Set start command: `npm start`

3. **Deploy:**
   - Push to main branch
   - Railway auto-deploys

#### railway.json:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Fly.io

**Best for:** Global edge deployment

#### Steps:

1. **Install flyctl:**
```bash
curl -L https://fly.io/install.sh | sh
```

2. **Login:**
```bash
flyctl auth login
```

3. **Initialize:**
```bash
flyctl launch
```

4. **Deploy:**
```bash
flyctl deploy
```

#### fly.toml:

```toml
app = "spartan-multichain"
primary_region = "iad"

[build]
  builder = "paketobuildpacks/builder:base"
  buildpacks = ["gcr.io/paketo-buildpacks/nodejs"]

[env]
  PORT = "3001"
  NODE_ENV = "production"

[[services]]
  internal_port = 3001
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = 10000
    grace_period = "5s"
    method = "GET"
    path = "/health"
    protocol = "http"
    timeout = 2000
```

### AWS/DigitalOcean

**Best for:** Full control and customization

#### Steps:

1. **Provision Server:**
   - Ubuntu 22.04 LTS
   - 2GB+ RAM
   - 2+ CPU cores

2. **Setup Server:**
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Clone repository
git clone your-repo.git
cd multichain-miniapp

# Install dependencies
npm install

# Build
npm run build
```

3. **Configure PM2:**

Create `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'spartan-api',
    script: 'server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }]
}
```

Start with PM2:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

4. **Configure Nginx:**

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        root /var/www/spartan-multichain/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

5. **Setup SSL with Certbot:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Post-Deployment

### 1. Update Farcaster Metadata

Update `index.html` with your production URL:

```html
<meta property="fc:miniapp" content='{"version":"1","imageUrl":"https://your-domain.com/embed-image.png","button":{"title":"Spartan Multi-Chain","action":"https://your-domain.com"}}' />
```

### 2. Configure Farcaster Quick Auth

Update `.env`:
```env
HOSTNAME=your-domain.com
```

### 3. Test All Features

- [ ] Authentication works
- [ ] Portfolio loads correctly
- [ ] Swaps execute successfully
- [ ] Bridge transactions complete
- [ ] Social feed displays
- [ ] AI chat responds

### 4. Set Up Monitoring

**Health Checks:**
```bash
curl https://your-domain.com/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-02T12:00:00.000Z"
}
```

## Monitoring

### 1. Application Monitoring

**Sentry (Error Tracking):**
```bash
npm install @sentry/node
```

```javascript
import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
})
```

### 2. Performance Monitoring

**New Relic / Datadog:**
- Track API response times
- Monitor RPC call latency
- Track transaction success rates

### 3. Uptime Monitoring

Use services like:
- UptimeRobot
- Pingdom
- StatusCake

### 4. Log Management

**Papertrail / Logtail:**
```javascript
// Add to server.js
import winston from 'winston'
import { Logtail } from '@logtail/node'

const logtail = new Logtail(process.env.LOGTAIL_TOKEN)

const logger = winston.createLogger({
  transports: [logtail]
})
```

## Troubleshooting

### Build Fails

```bash
# Clear cache
rm -rf node_modules dist .turbo
npm install
npm run build
```

### CORS Errors

Update `server.js`:
```javascript
app.use(cors({
  origin: 'https://your-domain.com',
  credentials: true
}))
```

### Environment Variables Not Loading

Verify in deployment platform:
```bash
# Vercel
vercel env ls

# Railway
railway variables

# Fly.io
flyctl secrets list
```

### High Memory Usage

```javascript
// Add to server.js
if (process.env.NODE_ENV === 'production') {
  require('newrelic') // Monitor memory
  
  setInterval(() => {
    if (process.memoryUsage().heapUsed > 500 * 1024 * 1024) {
      console.warn('High memory usage detected')
    }
  }, 60000)
}
```

## Scaling

### Horizontal Scaling

1. **Load Balancer:** Use Nginx/AWS ALB
2. **Multiple Instances:** PM2 cluster mode
3. **Database:** Use external PostgreSQL
4. **Caching:** Redis for hot data

### Vertical Scaling

1. **Upgrade server:** More RAM/CPU
2. **Premium RPC:** Faster blockchain calls
3. **CDN:** Cloudflare for static assets

## Security Checklist

- [ ] HTTPS enforced
- [ ] Rate limiting enabled
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention
- [ ] XSS protection
- [ ] CSRF tokens
- [ ] Security headers configured
- [ ] Dependencies updated
- [ ] Penetration testing completed

## Backup Strategy

1. **Database:** Daily automated backups
2. **Environment:** Version-controlled configs
3. **Secrets:** Backed up in secret manager
4. **Code:** Git repository with tags

---

**Ready to deploy?** Follow the steps above and launch your Spartan Multi-Chain Mini App! 🛡️🚀

