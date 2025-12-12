# 🚀 XMRT-Eliza Vercel Deployment Instructions

## Quick Deployment (If package.json conflicts persist)

### Option 1: Use backup package.json
```bash
# In your local repository:
cp package-nextjs.json package.json
git add package.json
git commit -m "Use Next.js package.json for deployment"
git push origin main
```

### Option 2: Vercel Configuration
```
Framework: Next.js
Root Directory: ./
Build Command: cp package-nextjs.json package.json && npm install && npm run build
Output Directory: .next
Install Command: cp package-nextjs.json package.json && npm install
```

### Option 3: Manual Override
1. Delete package.json from repository
2. Rename package-nextjs.json to package.json
3. Commit and push

## Environment Variables (Required)
```
NODE_ENV=production
XMRT_AGENT_ID=xmrt-eliza-vercel
XMRT_SUPABASE_URL=https://vawouugtzwmejxqkeqqj.supabase.co
XMRT_ECOSYSTEM_URL=https://xmrt-ecosystem.vercel.app
XMRT_SUITE_AI_URL=https://suite.lovable.app
```

## API Endpoints Available
- GET /api/health - Health check
- GET /api/agents - XMRT agents list  
- GET /api/status - System status

## Files Ready for Deployment
✅ next.config.js - Next.js configuration
✅ vercel.json - Vercel settings
✅ pages/api/*.js - API routes
✅ package-nextjs.json - Clean dependencies
✅ Workflows disabled - No build conflicts

Your XMRT-Eliza system is ready for deployment! 🎉
