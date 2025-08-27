# ElizaOS Vercel Deployment Guide

## Current Setup

The ElizaOS app is configured to deploy to Vercel with the following structure:

- **Entry Point**: `packages/eliza-app/src/index.ts`
- **Vercel Config**: `vercel.json`
- **TypeScript**: Configured with `tsconfig.json`

## Environment Variables

Set these in your Vercel project settings:

```
FIRECRAWL_API_KEY=fc-your-api-key-here
```

## Deployment Steps

1. **Connect to Vercel**: Link your GitHub repository to Vercel
2. **Set Environment Variables**: Add the FIRECRAWL_API_KEY in Vercel dashboard
3. **Deploy**: Vercel will automatically build and deploy on push to main

## Current Issues Fixed

- ✅ Removed Prisma dependency to simplify deployment
- ✅ Fixed TypeScript configuration
- ✅ Updated Vercel configuration
- ✅ Fixed Firecrawl API endpoint (removed `/v0`)

## Testing the Deployment

Once deployed, test these endpoints:

- `https://your-app.vercel.app/` - Main interface
- `https://your-app.vercel.app/api/health` - Health check
- `https://your-app.vercel.app/api/chat` - Chat endpoint
- `https://your-app.vercel.app/api/firecrawl` - Firecrawl test

## Next Steps

1. Deploy and test the basic functionality
2. Add back Prisma database integration once basic deployment works
3. Configure proper database connection for production
