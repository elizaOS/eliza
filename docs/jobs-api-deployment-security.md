# Jobs API Deployment Security Guide

## The Security Problem

When you deploy ElizaOS with the Jobs API enabled, **you must be careful about which endpoints you expose publicly**.

### ⚠️ The Issue

ElizaOS includes multiple API endpoints:

- ✅ `/api/messaging/jobs` - **Designed for public use** (with authentication)
- ❌ `/api/agents/:agentId/messages` - **Internal API** (admin only)
- ❌ `/api/channels` - **Internal API** (admin only)
- ❌ `/api/agents/:agentId/...` - **Internal API** (admin only)
- ❌ Other internal APIs - **Internal** (admin only)

**If you simply deploy on a public URL without proper configuration, ALL of these endpoints become publicly accessible!**

Even with `ELIZA_SERVER_AUTH_TOKEN` set, anyone with your API key can access ALL internal admin APIs, not just the Jobs endpoint.

### ✅ The Solution

**Use a reverse proxy (nginx) to expose ONLY the Jobs API endpoint publicly** while keeping all other APIs internal.

## Recommended Architecture

```
Internet
    ↓
[Nginx Reverse Proxy] ← Public-facing (port 80/443)
    ↓
    ├─→ /api/messaging/jobs → ElizaOS (port 3000) ✅ PUBLIC
    └─→ /api/* → BLOCKED ❌ INTERNAL ONLY

ElizaOS Server (localhost:3000) ← Not directly accessible from internet
```

## Nginx Configuration

### Basic Configuration (HTTP)

```nginx
# /etc/nginx/sites-available/eliza-jobs

server {
    listen 80;
    server_name your-domain.com;

    # Rate limiting to prevent abuse
    limit_req_zone $binary_remote_addr zone=jobs_limit:10m rate=10r/s;
    limit_req zone=jobs_limit burst=20 nodelay;

    # Jobs API - PUBLIC endpoint (with authentication required at app level)
    location /api/messaging/jobs {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Security headers
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
    }

    # Block ALL other API endpoints from public access
    location /api/ {
        deny all;
        return 403;
    }

    # Health check endpoint (optional, for monitoring)
    location /api/messaging/jobs/health {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Allow only from monitoring IPs (optional)
        # allow 1.2.3.4;  # Your monitoring service IP
        # deny all;
    }

    # Default - block everything else
    location / {
        deny all;
        return 404;
    }
}
```

### Production Configuration (HTTPS with SSL)

```nginx
# /etc/nginx/sites-available/eliza-jobs-ssl

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL certificates (use Let's Encrypt with certbot)
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=jobs_limit:10m rate=10r/s;
    limit_req zone=jobs_limit burst=20 nodelay;

    # Jobs API - PUBLIC endpoint
    location /api/messaging/jobs {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Security headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    }

    # Health check
    location /api/messaging/jobs/health {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Block all other API endpoints
    location /api/ {
        deny all;
        return 403;
    }

    # Default - block everything else
    location / {
        deny all;
        return 404;
    }
}
```

## Step-by-Step Setup Guide

### 1. Install Nginx

**Ubuntu/Debian:**

```bash
sudo apt update
sudo apt install nginx
```

**CentOS/RHEL:**

```bash
sudo yum install nginx
```

**macOS:**

```bash
brew install nginx
```

### 2. Create Nginx Configuration

```bash
# Create configuration file
sudo nano /etc/nginx/sites-available/eliza-jobs

# Paste the configuration from above (choose HTTP or HTTPS)
# Replace 'your-domain.com' with your actual domain

# Create symbolic link to enable the site
sudo ln -s /etc/nginx/sites-available/eliza-jobs /etc/nginx/sites-enabled/

# Remove default nginx site (optional)
sudo rm /etc/nginx/sites-enabled/default
```

### 3. Set Up SSL Certificates (Production)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate (automatic nginx configuration)
sudo certbot --nginx -d your-domain.com

# Certbot will automatically:
# - Obtain SSL certificate from Let's Encrypt
# - Configure nginx with SSL
# - Set up auto-renewal
```

### 4. Test Nginx Configuration

```bash
# Test configuration syntax
sudo nginx -t

# If successful, you'll see:
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 5. Start/Reload Nginx

```bash
# Start nginx
sudo systemctl start nginx

# Enable nginx to start on boot
sudo systemctl enable nginx

# Reload nginx (after config changes)
sudo systemctl reload nginx

# Check status
sudo systemctl status nginx
```

### 6. Configure Firewall

```bash
# Allow HTTP and HTTPS
sudo ufw allow 'Nginx Full'

# Or if using specific ports:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 7. Verify Setup

```bash
# Test Jobs API (should work)
curl https://your-domain.com/api/messaging/jobs/health

# Test other APIs (should be blocked)
curl https://your-domain.com/api/agents
# Expected: 403 Forbidden

curl https://your-domain.com/api/channels
# Expected: 403 Forbidden
```

## Environment Variables Setup

Even with nginx, you still need to secure the Jobs API endpoint itself:

```bash
# In your ElizaOS .env file

# Option 1: API Key Authentication (Recommended)
ELIZA_SERVER_AUTH_TOKEN=your-secret-key-here

# Option 2: X402 Payment Authentication
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234...
X402_PRICE=$0.01

# Option 3: Both (Maximum Security)
ELIZA_SERVER_AUTH_TOKEN=your-secret-key-here
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234...
```

## Alternative: Cloudflare Tunnel (No nginx required)

If you can't set up nginx, you can use Cloudflare Tunnel with access rules:

### 1. Install Cloudflare Tunnel

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
sudo mv cloudflared /usr/local/bin/
sudo chmod +x /usr/local/bin/cloudflared
```

### 2. Create Tunnel

```bash
# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create eliza-jobs

# Configure tunnel
nano ~/.cloudflared/config.yml
```

### 3. Configure Cloudflare Access Rules

In Cloudflare dashboard:

1. Go to Zero Trust → Access → Applications
2. Create application for `your-domain.com/api/messaging/jobs/*`
3. Set access policy (allow all or specific rules)
4. Block all other paths

## Platform-Specific Guides

### Railway

Railway doesn't support nginx natively. Options:

1. **Deploy nginx as a separate service** that proxies to your ElizaOS service
2. **Use Cloudflare Tunnel** (recommended)
3. **Deploy on a VPS instead** (DigitalOcean, AWS, etc.)

### Phala Cloud

Similar to Railway - limited reverse proxy support. Use Cloudflare Tunnel or deploy on traditional VPS.

### VPS (DigitalOcean, AWS EC2, Linode, etc.)

Follow the full nginx setup guide above. This is the recommended approach for production.

## Security Checklist

Before going to production:

- [ ] ✅ Nginx configured to expose ONLY `/api/messaging/jobs`
- [ ] ✅ All other `/api/*` endpoints return 403 Forbidden
- [ ] ✅ SSL/HTTPS enabled with valid certificate
- [ ] ✅ Rate limiting configured (prevent abuse)
- [ ] ✅ `ELIZA_SERVER_AUTH_TOKEN` or X402 enabled
- [ ] ✅ Firewall configured (only 80/443 open)
- [ ] ✅ ElizaOS running on localhost (not 0.0.0.0)
- [ ] ✅ Security headers configured
- [ ] ❌ Never expose port 3000 directly to the internet
- [ ] ❌ Never skip SSL in production
- [ ] ❌ Never use weak API keys

## Testing Your Setup

### Test Public Access (Should Work)

```bash
# Create job (with authentication)
curl -X POST https://your-domain.com/api/messaging/jobs \
  -H "X-API-KEY: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "content": "Hello agent"
  }'

# Get job status
curl https://your-domain.com/api/messaging/jobs/JOB_ID \
  -H "X-API-KEY: your-secret-key"

# Health check
curl https://your-domain.com/api/messaging/jobs/health
```

### Test Internal APIs (Should Be Blocked)

```bash
# These should all return 403 Forbidden
curl https://your-domain.com/api/agents
curl https://your-domain.com/api/channels
curl https://your-domain.com/api/agents/123/messages
```

If these return 403, your setup is secure! ✅

## Monitoring and Logs

### Nginx Logs

```bash
# Access logs (all requests)
sudo tail -f /var/log/nginx/access.log

# Error logs (blocked requests, errors)
sudo tail -f /var/log/nginx/error.log

# Filter for blocked requests
sudo grep "403" /var/log/nginx/access.log
```

### ElizaOS Logs

```bash
# Check ElizaOS logs for job processing
pm2 logs eliza
# or
docker logs eliza-container
```

## Troubleshooting

### Jobs API returns 502 Bad Gateway

**Cause:** ElizaOS is not running or nginx can't connect to it.

**Solution:**

```bash
# Check if ElizaOS is running
sudo netstat -tlnp | grep 3000
# Should show ElizaOS listening on port 3000

# Restart ElizaOS
pm2 restart eliza
```

### Jobs API returns 403 Forbidden

**Cause:** Your nginx location rule is too restrictive.

**Solution:** Check your nginx config:

```nginx
# Make sure this comes BEFORE the general /api/ block:
location /api/messaging/jobs {
    proxy_pass http://localhost:3000;
    # ...
}

# This should come AFTER:
location /api/ {
    deny all;
    return 403;
}
```

### SSL certificate errors

**Solution:**

```bash
# Renew Let's Encrypt certificate
sudo certbot renew --dry-run
sudo certbot renew
sudo systemctl reload nginx
```

## Best Practices

1. **Always use HTTPS in production** - Never expose APIs over plain HTTP
2. **Use strong API keys** - Generate random 32+ character keys
3. **Enable rate limiting** - Prevent abuse and excessive usage
4. **Monitor logs regularly** - Watch for unusual patterns
5. **Keep ElizaOS on localhost** - Never bind to 0.0.0.0 if using nginx
6. **Update regularly** - Keep nginx and ElizaOS updated
7. **Backup configurations** - Save your nginx config files
8. **Test before deploying** - Always test nginx config with `nginx -t`

## Related Documentation

- [Jobs API Examples](./jobs-api-examples.md) - API usage and examples
- [X402 Payment Integration](./x402-payment-integration.md) - Payment setup
- [Nginx Documentation](https://nginx.org/en/docs/) - Official nginx docs

## Support

For deployment help:

- 📖 [ElizaOS Documentation](https://github.com/elizaos/eliza)
- 💬 [ElizaOS Discord](https://discord.gg/elizaos)
- 🐛 Report issues on GitHub
