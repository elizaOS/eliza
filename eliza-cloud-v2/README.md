# Eliza Cloud V2

A comprehensive AI agent development platform built with Next.js 15, featuring multi-model AI generation (text, image, video), full elizaOS runtime integration, enterprise authentication, credit-based billing, and production-ready cloud infrastructure.

## 📋 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Development](#development)
- [Production Security](#production-security)
- [Platform Features](#platform-features)
- [Database Architecture](#database-architecture)
- [API Reference](#api-reference)
- [Deployment](#deployment)
- [Mobile App (iOS & Android)](#-mobile-app-ios--android)
- [AWS ECS Container Deployment](#-aws-ecs-container-deployment)
- [Troubleshooting](#troubleshooting)
- [Additional Resources](#additional-resources)

## 🎯 Overview

Eliza Cloud V2 is a full-stack AI-as-a-Service platform that combines:

- **Multi-Modal AI Generation**: Text chat, image creation, and video generation
- **elizaOS Integration**: Full-featured autonomous agent runtime with memory, rooms, and plugins
- **SaaS Platform**: User management, API keys, credit-based billing, usage tracking
- **Container Deployment**: Deploy elizaOS projects via `elizaos deploy` CLI to AWS ECS
- **Enterprise Features**: Privy authentication with multi-provider support, Stripe billing, ECR image storage, health monitoring

## ✨ Key Features

### 🤖 AI Generation Studio

- **Text & Chat**:
  - Multi-model support (GPT-4, Claude, Gemini, etc.) via AI SDK Gateway
  - Real-time streaming responses
  - Conversation persistence with full history
  - Model selection and configuration

- **Image Creation**:
  - Google Gemini 2.5 Flash multimodal generation
  - High-quality images (1024x1024)
  - Automatic Vercel Blob storage
  - Base64 preview + downloadable files

- **Video Generation**:
  - Multiple Fal.ai models: Veo3, Kling v2.1, MiniMax Hailuo
  - Long-form video support (up to 5 minutes)
  - Automatic Vercel Blob upload
  - Fallback handling with error recovery

### 🧠 elizaOS Runtime Integration

- **Full Agent Runtime**:
  - AgentRuntime from `@elizaos/core` with PostgreSQL database
  - Memory system with vector embeddings (384-3072 dimensions)
  - Rooms, participants, relationships, and entities
  - Plugin system with custom providers and actions

- **Character Creator**:
  - AI-assisted character definition builder
  - Progressive JSON generation with live preview
  - Import/export elizaOS-compatible character files
  - Support for all character fields (bio, style, plugins, knowledge, etc.)

- **Agent Chat Interface**:
  - Chat with deployed elizaOS agents via rooms
  - Message persistence and history
  - Real-time WebSocket updates (future)
  - Multi-agent conversations

### 💳 SaaS Platform Features

- **Billing System**:
  - Add funds via Stripe integration
  - Automatic deduction for AI operations
  - Usage tracking per organization/user
  - Credit packs with volume pricing

- **API Key Management**:
  - Generate API keys for programmatic access
  - Key rotation and regeneration
  - Rate limiting per key
  - Usage statistics and audit logs

- **Container Deployments**:
  - Deploy elizaOS projects via `elizaos deploy` CLI
  - Docker-based deployments to AWS ECS (Elastic Container Service)
  - ECR (Elastic Container Registry) for Docker image storage
  - EC2-based ECS (t4g.small ARM instances, 1 per user)
  - Health checks and monitoring via ECS

### 📊 Management & Analytics

- **Dashboard**:
  - Usage overview with charts (Recharts)
  - Provider health monitoring
  - Credit activity timeline
  - Model usage breakdown

- **Gallery**:
  - View all generated images and videos
  - Filter by type (image/video)
  - Download or delete media
  - Storage usage statistics

- **Analytics**:
  - Usage records by model, provider, type
  - Cost breakdown and trends
  - Error tracking and success rates

### 🔐 Security & Infrastructure

- **Enterprise Auth**:
  - Privy authentication with email, wallet, and social logins
  - Organization and user management
  - Webhook-based user synchronization
  - Role-based access (admin, member)

- **Billing Integration**:
  - Stripe Checkout for credit purchases
  - Webhook processing with idempotency
  - Tax ID collection for businesses
  - Invoice generation

- **Type Safety**:
  - Full TypeScript coverage
  - Zod validation for API requests
  - Drizzle ORM with type-safe queries

## 🏗 Architecture

### Directory Structure

```
eliza-cloud-v2/
├── app/                      # Next.js App Router
│   ├── api/                  # API routes
│   │   ├── v1/              # Versioned API
│   │   │   ├── chat/        # AI text generation
│   │   │   ├── generate-image/  # Image generation
│   │   │   ├── generate-video/  # Video generation
│   │   │   ├── gallery/     # Media gallery
│   │   │   ├── containers/  # Container management (AWS ECS/ECR)
│   │   │   ├── api-keys/    # API key CRUD
│   │   │   ├── character-assistant/  # Character creator AI
│   │   │   ├── user/        # User info
│   │   │   └── models/      # Available AI models
│   │   ├── eliza/           # elizaOS agent API
│   │   │   └── rooms/       # Agent rooms and messages
│   │   ├── stripe/          # Stripe webhooks and checkout
│   │   └── fal/             # Fal.ai proxy
│   ├── dashboard/           # Protected dashboard pages
│   │   ├── text/            # Text chat interface
│   │   ├── image/           # Image generation studio
│   │   ├── video/           # Video generation studio
│   │   ├── gallery/         # Generated media gallery
│   │   ├── containers/      # Container management UI
│   │   ├── api-keys/        # API key management
│   │   ├── billing/         # Credits and billing
│   │   ├── analytics/       # Usage analytics
│   │   ├── account/         # Account settings
│   │   ├── character-creator/  # Character builder
│   │   ├── eliza/           # elizaOS agent chat
│   │   └── storage/         # Storage management
│   ├── actions/             # Server actions
│   │   ├── auth.ts          # Auth actions
│   │   ├── gallery.ts       # Gallery actions
│   │   ├── characters.ts    # Character CRUD
│   │   ├── conversations.ts # Conversation management
│   │   └── users.ts         # User actions
│   ├── layout.tsx           # Root layout with analytics
│   ├── page.tsx             # Landing page
│   └── globals.css          # Global styles (Tailwind)
├── components/              # React components
│   ├── chat/                # Chat interfaces
│   ├── image/               # Image generation UI
│   ├── video/               # Video generation UI
│   ├── gallery/             # Gallery grid and display
│   ├── containers/          # Container tables
│   ├── api-keys/            # API key management UI
│   ├── billing/             # Credit packs and billing
│   ├── character-creator/   # Character builder UI
│   ├── dashboard/           # Dashboard metrics and cards
│   ├── layout/              # Header, sidebar, navigation
│   ├── theme/               # Theme provider and toggle
│   ├── ui/                  # Reusable UI components (45+ components)
│   └── ai-elements/         # AI-specific UI components
├── db/                      # Database layer
│   ├── sass/                # SaaS platform schema
│   │   └── schema.ts        # Organizations, users, API keys, credits, etc.
│   ├── eliza/               # elizaOS runtime schema
│   │   └── schema.ts        # Agents, memories, rooms, embeddings, etc.
│   ├── drizzle.ts           # Database client
│   └── migrations/          # Migration SQL files
├── lib/                     # Shared utilities
│   ├── queries/             # Database queries (12 files)
│   │   ├── api-keys.ts      # API key operations
│   │   ├── credits.ts       # Credit transactions
│   │   ├── containers.ts    # Container CRUD
│   │   ├── container-quota.ts  # Quota enforcement
│   │   ├── generations.ts   # Media generation records
│   │   ├── usage.ts         # Usage tracking
│   │   └── ...
│   ├── services/            # Business logic services
│   │   ├── ecr.ts           # AWS ECR integration
│   │   ├── ecs.ts           # AWS ECS deployment
│   │   ├── health-monitor.ts  # Provider health checks
│   │   └── containers.ts    # Container management
│   ├── eliza/               # elizaOS integration
│   │   ├── agent-runtime.ts # AgentRuntime wrapper
│   │   ├── agent.ts         # Agent management
│   │   └── plugin-assistant/  # Custom elizaOS plugin
│   ├── config/              # Configuration
│   │   ├── env-validator.ts # Environment validation
│   │   ├── env-consolidation.ts  # Config helpers
│   │   └── startup.ts       # Startup checks
│   ├── errors/              # Custom error classes
│   ├── middleware/          # Middleware utilities
│   ├── auth.ts              # Auth helpers
│   ├── blob.ts              # Vercel Blob utilities
│   ├── stripe.ts            # Stripe client
│   ├── pricing.ts           # Cost calculations
│   ├── rate-limiter.ts      # Rate limiting
│   ├── utils.ts             # General utilities
│   └── types.ts             # Shared TypeScript types
├── docs/                    # Detailed documentation
│   ├── API_REFERENCE.md    # Complete API reference
│   ├── DEPLOYMENT.md       # Deployment guide
│   ├── DEPLOYMENT_TROUBLESHOOTING.md  # Troubleshooting
│   ├── STRIPE_SETUP.md     # Stripe integration
│   ├── ENV_VARIABLES.md    # Environment configuration
│   └── ...
├── scripts/                 # Utility scripts
│   ├── seed-credit-packs.ts
│   └── ...
├── middleware.ts            # Next.js middleware (auth)
├── drizzle.config.ts        # Drizzle Kit config
└── package.json             # Dependencies
```

### Request Flow

```mermaid
graph TD
    A[Client Request] --> B[Next.js Middleware]
    B --> C{Auth Required?}
    C -->|Yes| D[Privy Auth]
    C -->|No| E[Route Handler]
    D -->|Authenticated| E
    D -->|Unauthenticated| F[Redirect to Login]
    E --> G{Request Type}
    G -->|AI Chat| H[AI SDK Gateway]
    G -->|Image/Video| I[Gemini/Fal.ai]
    G -->|Data| J[Drizzle ORM]
    G -->|Container| K[AWS ECS/ECR]
    G -->|elizaOS| L[AgentRuntime]
    H --> M[Response]
    I --> M
    J --> N[PostgreSQL]
    K --> M
    L --> N
    N --> M
```

### Database Architecture

The platform uses a single database with integrated schemas:

1. **Platform Schemas** (`db/schemas/*.ts`): Platform infrastructure
   - Organizations (`db/schemas/organizations.ts`), users (`db/schemas/users.ts`), authentication
   - API keys (`db/schemas/api-keys.ts`), usage tracking (`db/schemas/usage-records.ts`)
   - Credit system (`db/schemas/credit-transactions.ts`, `db/schemas/credit-packs.ts`), billing, Stripe integration
   - Containers (`db/schemas/containers.ts`), ECS/ECR deployments
   - Generations (`db/schemas/generations.ts` - image/video records)
   - Conversations (`db/schemas/conversations.ts` - platform-level chat)
   - **elizaOS Tables** (integrated via `@elizaos/plugin-sql` schema):
     - Agents (character definitions)
     - Memories with vector embeddings
     - Rooms and participants
     - Entities and relationships
     - Components and tasks
     - Message servers and channels

## 🛠 Tech Stack

### Core Framework

- **Next.js 15.5.4**: React framework with App Router, Turbopack, and Server Actions
- **React 19.2.0**: Latest UI library with server components
- **TypeScript 5**: Full type safety

### Database & ORM

- **PostgreSQL**: Single database with all tables
  - Platform tables: SaaS tables (users, credits, containers, etc.)
  - elizaOS tables: Agent runtime tables (agents, memories, rooms, etc.)
- **Drizzle ORM 0.44.6**: Type-safe SQL ORM
- **Drizzle Kit 0.31.5**: Migrations and schema management
- **pgvector**: Vector similarity search for embeddings

### Authentication & Billing

- **Privy Auth**: Web3-native authentication with multi-provider support (email, wallet, social logins)
  - `@privy-io/react-auth` for frontend
  - `@privy-io/server-auth` for backend token verification
- **Stripe 19.1.0**: Payment processing and credit purchases
- **@stripe/stripe-js 8.0.0**: Client-side Stripe integration

### AI & Machine Learning

- **AI SDK 5.0.60**: Vercel AI SDK for streaming
- **@ai-sdk/gateway 1.0.33**: Multi-provider AI routing
- **@ai-sdk/openai 2.0.43**: OpenAI provider
- **@ai-sdk/react 2.0.60**: React hooks for AI
- **@fal-ai/client 1.6.2**: Fal.ai video generation
- **@elizaos/core 1.6.1**: elizaOS agent runtime
- **@elizaos/plugin-openai 1.5.15**: OpenAI plugin for elizaOS
- **@elizaos/plugin-sql 1.6.1**: SQL database plugin for elizaOS

### Storage & Infrastructure

- **Vercel Blob 2.0.0**: Media storage (images/videos)
- **@aws-sdk/client-ecr 3.x**: AWS Elastic Container Registry
- **@aws-sdk/client-ecs 3.x**: AWS Elastic Container Service deployment

### Styling & UI

- **Tailwind CSS 4.1.14**: Utility-first CSS framework
- **Radix UI**: 20+ accessible, unstyled UI primitives
- **Lucide React 0.545.0**: Icon library (1000+ icons)
- **class-variance-authority 0.7.1**: Component variants
- **next-themes 0.4.6**: Dark/light mode support
- **motion 12.23.22**: Animation library
- **Sonner 2.0.7**: Toast notifications
- **Recharts 2.15.4**: Charts for analytics

### Development Tools

- **ESLint 9.37.0**: Code linting
- **Prettier 3.6.2**: Code formatting
- **tsx 4.19.2**: TypeScript execution
- **Zod 4.1.11**: Schema validation

## 📦 Prerequisites

### Required Software

- **Node.js**: v20 or higher
- **npm**: v10 or higher
- **Git**: For version control

### Required Services

1. **Neon Database** ([neon.tech](https://neon.tech))
   - Create a new project
   - Copy the connection string

2. **Privy** ([privy.io](https://privy.io))
   - Create an application
   - Configure webhook endpoint: `http://localhost:3000/api/privy/webhook`
   - Enable desired login methods (email, wallet, social)
   - Note your Client ID and API Key

3. **OpenAI or AI Gateway** (at least one)
   - OpenAI API key for direct access, OR
   - AI Gateway API key for multi-provider access

### Optional Services

4. **Vercel Blob** ([vercel.com](https://vercel.com/storage))
   - Required for Gallery feature
   - Create a Blob store and copy token

5. **Fal.ai** ([fal.ai](https://fal.ai))
   - Required for video generation
   - Create account and get API key

6. **AWS** ([aws.amazon.com](https://aws.amazon.com))
   - Required for container deployments
   - AWS credentials (Access Key ID, Secret Access Key)
   - ECS/ECR configuration, VPC, subnets, security groups

7. **Stripe** ([stripe.com](https://stripe.com))
   - Required for billing/credits
   - Secret key and webhook secret

## 🚀 Quick Start

### 1. Clone and Install

```bash
cd eliza-cloud-v2
npm install
```

### 2. Environment Setup

Copy the example environment file:

```bash
cp example.env.local .env.local
```

Edit `.env.local` with your credentials (see [example.env.local](example.env.local) for all options).

**Minimum required variables:**

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require

# Privy Authentication
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id_here
PRIVY_APP_SECRET=your_privy_app_secret_here
PRIVY_WEBHOOK_SECRET=replace_with_strong_random_secret

# AI (at least one)
OPENAI_API_KEY=sk-your_openai_key
# OR
AI_GATEWAY_API_KEY=your_gateway_key
```

**Generate secure passwords:**

```bash
# Generate PRIVY_WEBHOOK_SECRET (min 32 chars)
openssl rand -base64 32

# Generate CRON_SECRET
openssl rand -hex 32
```

### 3. Database Setup

Run migrations to create all tables:

```bash
npm run db:migrate
```

### 4. Seed Credit Packs (Optional)

If using Stripe billing:

```bash
npm run seed:credit-packs
```

This creates credit pack products in Stripe.

### 5. Start Development Server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

### 6. First Login

1. Click "Sign In" → Privy will create your user
2. You'll be redirected to the dashboard
3. Your organization starts with 10,000 credits

## 💻 Development

### Available Scripts

```bash
# Development
npm run dev              # Start dev server with Turbopack
npm run build            # Production build with Turbopack
npm start                # Start production server

# Database
npm run db:generate      # Generate migrations from schema changes
npm run db:migrate       # Run pending migrations
npm run db:studio        # Open Drizzle Studio

# Code Quality
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix ESLint issues
npm run format           # Format with Prettier
npm run format:check     # Check formatting
npm run check-types      # TypeScript type checking

# Utilities
npm run seed:credit-packs   # Seed Stripe credit packs
npm run bootstrapper:build  # Build container bootstrapper
```

### Development Workflow

1. **Start dev server**: `npm run dev`
2. **Make changes**: Edit files in `app/`, `components/`, `lib/`
3. **Instant feedback**: Turbopack provides sub-second HMR
4. **Test features**: Navigate to `/dashboard` routes
5. **Check types**: `npm run check-types`
6. **Database changes**: Edit `db/schemas/*.ts` → `npm run db:generate` → `npm run db:migrate`

### Project Structure Guidelines

- **`app/`**: Routes, API handlers, server actions
- **`components/`**: Reusable React components
- **`lib/`**: Business logic, database queries, services
- **`db/`**: Database schemas and migrations
- **Server Components**: Default for all components
- **Client Components**: Only when needed (`'use client'`)

## 🔐 Production Security

⚠️ **IMPORTANT**: Before deploying to production, you MUST complete the security configuration for Privy authentication.

### Security Features Implemented

✅ **Content Security Policy (CSP)**: Comprehensive CSP configured in `next.config.ts` that:

- Protects against XSS attacks
- Allows Privy authentication iframe
- Allows WalletConnect and wallet integrations
- Prevents clickjacking with frame-ancestors restrictions
- Includes all required domains for Privy, Solana, and third-party services

✅ **Security Headers**: Multiple layers of protection:

- `X-Frame-Options: DENY` (clickjacking protection)
- `X-Content-Type-Options: nosniff` (MIME sniffing protection)
- `Referrer-Policy` (referrer information control)
- `X-XSS-Protection` (browser XSS protection)
- `Permissions-Policy` (browser feature restrictions)

### Pre-Production Checklist

Before deploying to production, complete these critical steps:

#### 1. Configure Privy Dashboard

Visit https://dashboard.privy.io and configure:

- ✅ Add production domain to **Allowed Domains**
- ✅ Remove all test/development domains
- ✅ Enable **HttpOnly cookies** for enhanced security
- ✅ Complete domain ownership verification
- ✅ Configure MFA settings (disable SMS, enable authenticator apps)
- ✅ Review OAuth providers and session duration

#### 2. Set Environment Variables

```bash
NEXT_PUBLIC_PRIVY_APP_ID=your_production_app_id
NEXT_PUBLIC_PRIVY_CLIENT_ID=your_production_client_id
PRIVY_APP_SECRET=your_production_app_secret
PRIVY_WEBHOOK_SECRET=strong_random_secret_here
```

#### 3. Test Security Configuration

```bash
# Build and run in production mode
npm run build
npm run start

# Test security headers (in another terminal)
npm run test:security-headers

# Test all authentication flows
# - Login with all methods
# - Wallet connections
# - Transactions
# - Check browser console for CSP violations
```

### Documentation

Complete security documentation is available:

- **Quick Start**: [docs/PRIVY_PRODUCTION_QUICKSTART.md](./docs/PRIVY_PRODUCTION_QUICKSTART.md) - 5-minute setup guide
- **Complete Guide**: [docs/PRIVY_PRODUCTION_SECURITY.md](./docs/PRIVY_PRODUCTION_SECURITY.md) - Comprehensive security documentation
- **CSP Testing**: [docs/CSP_TESTING_GUIDE.md](./docs/CSP_TESTING_GUIDE.md) - Testing and debugging CSP
- **Full Checklist**: [docs/PRODUCTION_CHECKLIST.md](./docs/PRODUCTION_CHECKLIST.md) - Complete deployment checklist
- **Summary**: [SECURITY_UPDATES_SUMMARY.md](./SECURITY_UPDATES_SUMMARY.md) - What was implemented

### Testing Your Security Setup

Run the automated security headers test:

```bash
npm run test:security-headers
```

This will verify:

- All security headers are present
- CSP includes required Privy domains
- Frame embedding protection is active
- All security directives are configured

### Common Security Issues

**Issue: "Domain not allowed"**

- Solution: Add your domain to Privy Dashboard > Configuration > App settings > Allowed domains

**Issue: Privy iframe not loading**

- Solution: Check browser console for CSP violations. Verify `frame-src` includes `https://auth.privy.io`

**Issue: CSP violations**

- Solution: Review browser console, determine if legitimate, update `next.config.ts` if needed

See [docs/CSP_TESTING_GUIDE.md](./docs/CSP_TESTING_GUIDE.md) for detailed troubleshooting.

---

## 🔧 Platform Features

### 1. AI Text Generation

**Location**: `/dashboard/chat` and `/app/api/v1/chat/route.ts`

**Features**:

- Multi-model support (GPT-4, Claude, Gemini, etc.)
- Real-time streaming responses with `useChat` hook
- Conversation persistence with full history
- Model selection dropdown
- Token usage and cost tracking

**Usage**:

```typescript
import { useChat } from "@ai-sdk/react";

const { messages, input, handleSubmit, isLoading } = useChat({
  api: "/api/v1/chat",
  body: { model: "gpt-4o" },
});
```

**Cost**: Token-based pricing from `lib/pricing.ts`

### 2. AI Image Generation

**Location**: `/dashboard/image` and `/app/api/v1/generate-image/route.ts`

**Features**:

- Google Gemini 2.5 Flash multimodal generation
- High-quality 1024x1024 images
- Automatic Vercel Blob upload
- Base64 preview for instant display
- Download functionality

**API**:

```bash
POST /api/v1/generate-image
Content-Type: application/json
Authorization: Bearer eliza_your_api_key

{
  "prompt": "A serene landscape with mountains and lake at sunset"
}
```

**Cost**: $0.01 per image

### 3. AI Video Generation

**Location**: `/dashboard/video` and `/app/api/v1/generate-video/route.ts`

**Features**:

- Multiple Fal.ai models:
  - `fal-ai/veo3` (Google Veo 3)
  - `fal-ai/veo3/fast` (faster version)
  - `fal-ai/kling-video/v2.1/pro/text-to-video` (Kling Pro)
  - `fal-ai/minimax/hailuo-02/pro/text-to-video` (MiniMax)
- Automatic Vercel Blob upload
- Progress tracking with queue updates
- Fallback video on errors

**API**:

```bash
POST /api/v1/generate-video
Content-Type: application/json
Authorization: Bearer eliza_your_api_key

{
  "prompt": "A cinematic shot of a spaceship flying through stars",
  "model": "fal-ai/veo3"
}
```

**Cost**: $0.05 per video ($0.025 for fallback)

### 4. Gallery & Media Storage

**Location**: `/dashboard/gallery`

**Features**:

- View all generated images and videos
- Filter by type (image, video, all)
- Grid layout with thumbnails
- Full-size preview with details
- Download media files
- Delete from both DB and Vercel Blob
- Storage usage statistics

**Vercel Blob Benefits**:

- Global CDN delivery (19 edge regions)
- Public access with unguessable URLs
- Automatic caching
- No upload fees (only downloads charged)
- Hierarchical folder structure

**Setup**:

```bash
# 1. Create Blob store in Vercel Dashboard
# 2. Copy BLOB_READ_WRITE_TOKEN to .env.local
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_your_token
```

### 5. Container Deployments

**Location**: `/dashboard/containers` and `/app/api/v1/containers/route.ts`

**Features**:

- Deploy elizaOS projects via `elizaos deploy` CLI
- **Multi-project support**: Deploy multiple different projects per user
- **Multi-architecture support**: Auto-detects platform and deploys to matching AWS instance type
  - **ARM64**: t4g.small (AWS Graviton2, $15.76/month) - Recommended for cost savings
  - **x86_64**: t3.small (Intel/AMD, $18.68/month) - Universal compatibility
- **Smart update detection**: Automatically detects and updates existing deployments
- Docker-based deployments to AWS ECS (Elastic Container Service)
- ECR (Elastic Container Registry) for Docker image storage with project-specific repositories
- CloudFormation stack per project: `elizaos-{userId}-{projectName}`
- Optimized health checks (15s interval, 5min grace period)
- Health monitoring via CloudWatch and ECS
- Quota enforcement (prevents race conditions)
- Environment variable injection
- Credit-based billing with automatic deduction
- Container management CLI: `elizaos containers list|delete|logs`
- **Async deployment**: API returns immediately, CLI polls with beautiful progress

**How It Works**:

1. User gets API key from `/dashboard/api-keys`
2. User runs `elizaos deploy --project-name my-project --api-key eliza_xxxxx` from project directory
3. CLI auto-detects if project already deployed (checks `project_name`)
4. CLI requests ECR credentials from the cloud API
5. CLI builds Docker image locally using project's Dockerfile (or generates one)
6. CLI pushes Docker image to project-specific ECR repository
7. CLI creates/updates container deployment via cloud API:
   - **Fresh deployment**: Creates new CloudFormation stack
   - **Update deployment**: Updates existing CloudFormation stack (zero-downtime)
8. Cloud provisions/updates dedicated EC2 instance with ECS
9. Container accessible via AWS Load Balancer URL
10. Credits automatically deducted based on container resources (CPU/memory)

**Multi-Project Example**:

```bash
# Deploy first project
cd ~/chatbot
elizaos deploy --project-name chatbot --api-key eliza_xxx
# URL: https://fc51b251-chatbot.containers.elizacloud.ai

# Deploy second project (same user, different project)
cd ~/assistant
elizaos deploy --project-name assistant --api-key eliza_xxx
# URL: https://fc51b251-assistant.containers.elizacloud.ai

# Update chatbot
cd ~/chatbot
# ... make changes ...
elizaos deploy --project-name chatbot  # Auto-detected as update
# URL unchanged: https://fc51b251-chatbot.containers.elizacloud.ai
```

**Human-Readable URLs**:

- Format: `https://{userId-prefix}-{project-name}.containers.elizacloud.ai`
- Example: `https://fc51b251-chatbot.containers.elizacloud.ai`
- Uses first segment of UUID + project name for easy recognition

**Instance Specs (Auto-Selected)**:

**ARM64 (t4g.small - Recommended)**:

- **2 vCPUs** (ARM Graviton2)
- **2 GiB RAM** (2048 MB)
- **$15.76/month** ($12.26 instance + $3.50 storage/monitoring)
- Default container allocation: 1.75 vCPU (1792 units), 1.75 GiB RAM (1792 MB, 87.5% of instance)

**x86_64 (t3.small - Universal)**:

- **2 vCPUs** (Intel/AMD)
- **2 GiB RAM** (2048 MB)
- **$18.68/month** ($15.18 instance + $3.50 storage/monitoring)
- Default container allocation: 1.75 vCPU (1792 units), 1.75 GiB RAM (1792 MB, 87.5% of instance)

Platform is automatically detected from your system. ARM64 provides better cost efficiency ($2.92/month savings) while x86_64 ensures universal compatibility.

**Container Management**:

```bash
# List all containers (with project names)
elizaos containers list --api-key eliza_xxx

# View logs (auto-detects from current directory)
cd ~/chatbot
elizaos containers logs  # Finds chatbot project automatically

# Delete container (auto-detects from current directory)
cd ~/chatbot
elizaos containers delete  # Finds and deletes chatbot project
```

**Deployment Architecture**:

```
┌──────────────┐
│   CLI Tool   │
│  (elizaos)   │
└──────┬───────┘
       │ 1. Request ECR credentials
       ▼
┌──────────────┐
│  Cloud API   │
│   (Next.js)  │
└──────┬───────┘
       │ 2. Return ECR auth token + repository
       ▼
┌──────────────┐
│  Docker CLI  │
│ (local build)│
└──────┬───────┘
       │ 3. Push image to ECR
       ▼
┌──────────────┐     4. Deploy container     ┌──────────────┐
│     ECR      │ ─────────────────────────▶ │  EC2 + ECS   │
│  (Registry)  │                              │  (Runtime)   │
└──────────────┘                              └──────┬───────┘
                                                      │
                                                      ▼
                                              ┌──────────────┐
                                              │ Load Balancer│
                                              │   (Public)   │
                                              └──────────────┘
```

**Docker Image Requirements**:

- Must expose a port (default: 3000)
- Must include a `/health` endpoint for ECS health checks
- Dockerfile can be auto-generated if not present
- Environment variables passed from cloud API

**API**:

```bash
POST /api/v1/containers
Content-Type: application/json
Authorization: Bearer eliza_your_api_key

{
  "name": "my-agent",
  "port": 3000,
  "max_instances": 1,
  "environment_vars": {
    "NODE_ENV": "production"
  },
  "ecr_image_uri": "123456789012.dkr.ecr.us-east-1.amazonaws.com/elizaos/my-project:latest"
}
```

**Requirements**:

- AWS account with ECS/ECR/EC2 access and CloudFormation permissions
- elizaOS Cloud account with API key
- VPC with public subnets configured
- IAM roles for ECS task execution
- Environment variables set (see `example.env.local` and `docs/ENV_VARIABLES.md`)

### 6. elizaOS Agent Integration

**Location**: `/dashboard/chat` and `lib/eliza/`

**Features**:

- Full `AgentRuntime` from `@elizaos/core`
- PostgreSQL-backed memory system
- Vector embeddings (384-3072 dimensions)
- Rooms for conversations
- Participants and relationships
- Custom plugins and providers

**Database Schema**:

- `agents`: Character definitions
- `memories`: Conversation history
- `embeddings`: Vector similarity search
- `rooms`: Conversation contexts
- `entities`: Users and participants
- `relationships`: Entity connections

**API**:

```bash
# Create room
POST /api/eliza/rooms
{
  "agentId": "uuid",
  "name": "Chat Room"
}

# Send message
POST /api/eliza/rooms/{roomId}/messages
{
  "content": "Hello, agent!",
  "authorId": "user-uuid"
}
```

### 7. Character Creator

**Location**: `/dashboard/character-creator` and `/app/api/v1/character-assistant/route.ts`

**Features**:

- AI-assisted character building using GPT-4o-mini
- Progressive JSON generation
- Live preview of character definition
- Import/export elizaOS-compatible JSON
- Support for all character fields:
  - name, username, bio, system prompt
  - messageExamples, postExamples
  - topics, adjectives, style
  - plugins, knowledge, settings

**Workflow**:

1. User describes character in natural language
2. AI generates JSON incrementally
3. User sees live preview
4. AI suggests improvements
5. Export as elizaOS character file

**Example**:

```json
{
  "name": "Alex",
  "bio": ["A friendly AI assistant", "Specializes in technical support"],
  "adjectives": ["helpful", "knowledgeable", "patient"],
  "system": "You are a helpful technical support agent...",
  "style": {
    "chat": ["Be concise", "Use bullet points"],
    "post": ["Be professional", "Include examples"]
  },
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai"]
}
```

### 8. Developer API & Programmatic Access

**Location**: Documented management endpoints that explicitly note API key support

API key authentication is available for the specific endpoints documented in this README (for example: `/api/v1/chat`, `/api/v1/generate-image`, `/api/v1/generate-video`, `/api/v1/containers`, `/api/v1/voice/*`, `/api/v1/billing/*`, `/api/v1/models`, `/api/v1/gallery`). Not every `/api/v1/` or `/api/my-agents/` route supports API keys today, so rely on the documented list, enabling:

- **Programmatic Agent Management**: Create, update, delete, and clone agents via API
- **Voice Integration**: Text-to-speech, speech-to-text, and voice cloning for voice-enabled applications
- **Billing Automation**: Monitor balance, configure auto-top-up, and manage credits programmatically
- **AI Agent Autonomy**: Enable AI agents to manage their own resources and budgets

Session-based auth only (no API key support yet): `/api/v1/api-keys`, `/api/v1/apps/[id]/deploy`, `/api/v1/dashboard`, `/api/my-agents/characters/[id]/track-interaction`.

**Why API Keys for Management Endpoints?**

Traditional SaaS platforms only expose limited APIs. We've enabled API key authentication across these management endpoints because:

1. **Developer Experience**: Developers can build integrations without browser-based auth flows
2. **Agent Autonomy**: AI agents need to manage their own resources (credits, other agents, voices) autonomously
3. **Automation**: CI/CD pipelines, scripts, and external systems can interact with the platform programmatically
4. **No Vendor Lock-in**: Generic endpoint paths (`/api/v1/voice/` instead of provider-specific paths) allow switching providers without breaking integrations

**Generic Voice API**: Voice endpoints use provider-agnostic paths (`/api/v1/voice/tts` instead of `/api/elevenlabs/tts`) so your code doesn't need to change if the underlying provider changes. Legacy paths are preserved for backwards compatibility.

**Billing Management**: Agents and developers can configure auto-top-up settings programmatically, ensuring autonomous agents never stop working due to insufficient credits.

---

### 9. API Key Management

**Location**: `/dashboard/api-keys` and `/app/api/v1/api-keys/route.ts`

**Features**:

- Generate API keys for programmatic access
- Key rotation and regeneration
- Rate limiting per key (default 1000 req/day)
- Usage tracking and statistics
- Expires_at support for time-limited keys

**Key Format**: `eliza_<random_32_chars>`

**API**:

```bash
# Create API key
POST /api/v1/api-keys
{
  "name": "Production API Key",
  "description": "Main production key",
  "rate_limit": 10000
}

# Regenerate key
POST /api/v1/api-keys/{id}/regenerate

# Delete key
DELETE /api/v1/api-keys/{id}
```

**Using API Keys**:

```bash
curl https://your-app.com/api/v1/chat \
  -H "Authorization: Bearer eliza_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

### 9. Credit System & Billing

**Location**: `/dashboard/billing` and `lib/queries/credits.ts`

**Features**:

- Credit-based pricing model
- Stripe integration for purchases
- Credit packs with volume discounts
- Automatic deduction on usage
- Transaction history
- Organization-level balance

**Pricing**:

- **Text Chat**: Token-based (varies by model)
- **Image Generation**: $0.01 per image
- **Video Generation**: $0.05 per video
- **Container Running**: $0.67/day (~$20/month) - billed daily
- **Container Deployment**: $0.50 one-time per deployment
- **Voice Clone (Instant)**: 50 credits
- **Voice Clone (Professional)**: $2.00

**Stripe Integration**:

- Credit pack products defined in Stripe
- Checkout session for purchases
- Webhook processing for fulfillment
- Idempotency for duplicate webhooks

**Credit Packs** (example):

```typescript
[
  { name: "Starter", credits: 10000, price: 9.99 },
  { name: "Pro", credits: 50000, price: 39.99 },
  { name: "Enterprise", credits: 200000, price: 129.99 },
];
```

**Setup**:

See `docs/STRIPE_SETUP.md` for detailed Stripe configuration.

### 10. Analytics & Monitoring

**Location**: `/dashboard/analytics` and `lib/queries/usage.ts`

**Features**:

- Usage records per request (tokens, cost, model)
- Provider health monitoring
- Model usage breakdown (Recharts)
- Credit activity timeline
- Error rate tracking
- Response time monitoring

**Metrics Tracked**:

- Input/output tokens
- Cost per request
- Duration (ms)
- Success/failure status
- IP address and user agent
- Model and provider used

**Provider Health**:

- Automatic health checks for AI providers
- Status: healthy, degraded, unhealthy
- Response time percentiles
- Error rate calculation

### 11. MCP (Model Context Protocol) API

**Location**: `/app/api/mcp/route.ts`

**Features**:

- Standards-based MCP server implementation
- Platform tools exposed via MCP protocol
- Bearer token authentication using API keys
- Compatible with any MCP client (Claude Desktop, MCP Inspector, etc.)
- Automatic billing for tool usage

**Available MCP Tools**:

1. **check_credits**: View organization balance and recent transactions
2. **get_recent_usage**: View recent API usage statistics
3. **generate_text**: Generate text using AI models
4. **generate_image**: Generate images using Google Gemini 2.5
5. **save_memory**: Save to long-term memory
6. **retrieve_memories**: Search and retrieve memories
7. **chat_with_agent**: Chat with deployed elizaOS agents
8. **list_agents**: List all available agents
9. **list_containers**: List deployed containers

**Using MCP Inspector**:

```bash
npm run mcp:inspector
```

**Using with Claude Desktop**:

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "eliza-cloud": {
      "url": "http://localhost:3000/api/mcp",
      "transport": {
        "type": "streamableHttp"
      },
      "headers": {
        "Authorization": "Bearer eliza_your_api_key_here"
      }
    }
  }
}
```

## 🗄 Database Architecture

### SaaS Schema (`db/schemas/*.ts`)

**Core Tables**:

- **organizations**: Multi-tenant organization data
  - credit_balance, stripe_customer_id
  - allowed_models, allowed_providers
  - webhook_url for notifications

- **users**: User accounts linked to organizations
  - privy_user_id for authentication
  - role: admin, member
  - is_active for deactivation

- **api_keys**: API authentication
  - key_hash for secure storage
  - rate_limit, usage_count
  - permissions array

- **credit_transactions**: Credit ledger
  - amount (positive or negative)
  - type: purchase, deduction, refund, adjustment
  - stripe_payment_intent_id for reconciliation

- **credit_packs**: Balance top-up packages
  - stripe_price_id, stripe_product_id
  - sort_order for display

- **usage_records**: Per-request usage tracking
  - input_tokens, output_tokens
  - input_cost, output_cost
  - model, provider, type
  - is_successful, error_message

- **generations**: Image/video generation records
  - type: image, video
  - status: pending, completed, failed
  - storage_url (Vercel Blob)
  - dimensions, file_size, mime_type

- **containers**: AWS ECS container deployments
  - ecr_repository_uri, ecr_image_tag (Docker image in ECR)
  - ecs_cluster_arn, ecs_service_arn, ecs_task_definition_arn (ECS resources)
  - load_balancer_url (ALB URL for accessing the container)
  - status: pending, building, deploying, running, failed, stopped
  - environment_vars, desired_count, cpu, memory, port
  - Unique constraint on (organization_id, name)

- **alb_priorities**: Application Load Balancer priority management
  - Ensures each container gets a unique priority for ALB routing rules
  - Prevents priority conflicts when multiple containers share an ALB

- **conversations**: Platform-level chat history
  - title, model, settings
  - message_count, total_cost

- **conversation_messages**: Messages in conversations
  - role: user, assistant, system
  - sequence_number for ordering
  - tokens, cost, processing_time

- **user_characters**: User-created elizaOS characters
  - character_data (full JSON)
  - is_template, is_public
  - Stored separately from agents

- **model_pricing**: Dynamic pricing per model
  - input_cost_per_1k, output_cost_per_1k
  - effective_from, effective_until
  - is_active for versioning

- **provider_health**: AI provider status
  - status: healthy, degraded, unhealthy
  - response_time, error_rate
  - last_checked timestamp

- **jobs**: Background job queue
  - type, status: pending, in_progress, completed, failed
  - attempts, max_attempts
  - webhook_url for callbacks

### elizaOS Schema (Integrated)

Integrated into the main database via `@elizaos/plugin-sql` schema. These tables are managed by elizaOS core:

**Agent Runtime Tables**:

- **agents**: Character definitions
  - name, username, bio, system
  - messageExamples, postExamples
  - topics, adjectives, style
  - plugins, knowledge, settings

- **memories**: Conversation history
  - type (message, document, fragment)
  - content (JSONB)
  - unique flag for deduplication
  - metadata with document references

- **embeddings**: Vector similarity search
  - Multiple dimension columns:
    - dim384, dim512, dim768 (small-large)
    - dim1024, dim1536, dim3072 (XL-XXXL)
  - memory_id foreign key

- **rooms**: Conversation contexts
  - source (discord, telegram, web, etc.)
  - type (DM, group, channel)
  - world_id optional reference
  - channel_id for platform mapping

- **participants**: Room membership
  - entity_id, room_id, agent_id
  - room_state for custom data

- **entities**: Users and participants
  - names array for aliases
  - metadata JSONB

- **relationships**: Entity connections
  - source_entity_id, target_entity_id
  - agent_id scope
  - tags array
  - Unique constraint prevents duplicates

- **components**: ECS-style data
  - entity_id, room_id, world_id
  - type, data JSONB

- **worlds**: High-level grouping
  - agent_id, name, server_id

- **tasks**: Scheduled agent tasks
  - name, description, tags
  - metadata JSONB

- **cache**: Key-value cache
  - key, agent_id composite primary key
  - expires_at for TTL

- **logs**: Audit trail
  - entity_id, room_id, type
  - body JSONB

- **message_servers**: Central messaging (future)
  - source_type, source_id
  - For multi-platform agents

- **channels**: Message channels
  - message_server_id
  - type (text, voice, DM, etc.)

- **central_messages**: Cross-platform messages
  - channel_id, author_id
  - in_reply_to_root_message_id for threads

### Database Migrations

**Generate migration**:

```bash
bun run db:generate
```

This creates SQL migration files in `db/migrations/`.

**Apply migration**:

```bash
bun run db:migrate
```

### Race Condition Prevention

The platform implements atomic operations to prevent quota bypass:

**Example**: Container quota enforcement

```typescript
await db.transaction(async (tx) => {
  // 1. Lock organization row
  const org = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update");

  // 2. Count containers while holding lock
  const count = await tx
    .select()
    .from(containers)
    .where(eq(containers.organization_id, orgId));

  // 3. Check quota
  if (count >= maxAllowed) throw new QuotaExceededError();

  // 4. Create container
  return await tx.insert(containers).values(data);
});
```

See `lib/queries/container-quota.ts` for full implementation.

## 🔌 API Reference

### Authentication

Documented management endpoints that include API key examples support two authentication methods:

1. **Session Cookie** (Privy): Automatic for logged-in users
2. **API Key Header**: `Authorization: Bearer eliza_your_key`

### Base URL

- Development: `http://localhost:3000`
- Production: `https://your-domain.com`

### Endpoints

#### AI Generation

```bash
# Text Chat
POST /api/v1/chat
{
  "messages": [{"role": "user", "content": "Hello"}],
  "model": "gpt-4o"
}

# Image Generation
POST /api/v1/generate-image
{
  "prompt": "A beautiful sunset over mountains"
}

# Video Generation
POST /api/v1/generate-video
{
  "prompt": "Cinematic shot of spaceship",
  "model": "fal-ai/veo3"
}

# Available Models
GET /api/v1/models
```

#### Gallery

```bash
# List Media
GET /api/v1/gallery?type=image&limit=50&offset=0

# Response:
{
  "items": [...],
  "count": 10,
  "hasMore": false
}
```

#### Containers

```bash
# List Containers
GET /api/v1/containers

# Create Container
POST /api/v1/containers
{
  "name": "my-agent",
  "port": 3000,
  "ecr_image_uri": "123456789012.dkr.ecr.us-east-1.amazonaws.com/elizaos/my-project:v1.0.0",
  "environment_vars": {...},
  "cpu": 256,
  "memory": 512,
  "desired_count": 1
}

# Get Container
GET /api/v1/containers/{id}

# Delete Container
DELETE /api/v1/containers/{id}

# Check Quota
GET /api/v1/containers/quota
```

#### ECR Credentials

```bash
# Get ECR credentials for pushing Docker images
POST /api/v1/containers/credentials
{
  "projectId": "my-project",
  "version": "1.0.0"
}

# Response includes:
# - ecrRepositoryUri: Where to push the image
# - authToken: Docker login credentials
# - ecrImageUri: Full image URI to use in deployment
```

#### API Keys

```bash
# Create Key
POST /api/v1/api-keys
{
  "name": "Production",
  "rate_limit": 10000
}

# List Keys
GET /api/v1/api-keys

# Regenerate Key
POST /api/v1/api-keys/{id}/regenerate

# Delete Key
DELETE /api/v1/api-keys/{id}
```

#### User Info

```bash
# Get Current User
GET /api/v1/user

# Response:
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "organization": {...},
  "credit_balance": 5000
}
```

#### elizaOS Agents

```bash
# Create Room
POST /api/eliza/rooms
{
  "agentId": "uuid",
  "name": "Chat"
}

# Get Room Messages
GET /api/eliza/rooms/{roomId}/messages

# Send Message
POST /api/eliza/rooms/{roomId}/messages
{
  "content": "Hello!",
  "authorId": "user-uuid"
}
```

### Rate Limiting

- **Default**: 1000 requests/day per API key
- **Container Deployments**: 5 per 5 minutes
- **Billing Endpoints**: 100 per hour

Rate limits return:

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 3600
}
```

### Error Responses

```json
{
  "success": false,
  "error": "Error message",
  "details": {...}
}
```

HTTP Status Codes:

- `400`: Bad Request (validation error)
- `401`: Unauthorized (missing/invalid auth)
- `403`: Forbidden (insufficient permissions)
- `404`: Not Found
- `429`: Too Many Requests (rate limited)
- `500`: Internal Server Error
- `503`: Service Unavailable (feature not configured)

## 🚢 Deployment

### Deploying to Vercel (Recommended)

**1. Push to GitHub**:

```bash
git add .
git commit -m "Initial commit"
git push origin main
```

**2. Import to Vercel**:

- Go to [vercel.com/new](https://vercel.com/new)
- Import your repository
- Vercel auto-detects Next.js

**3. Configure Environment Variables**:

Add all variables from `.env.local` in Vercel dashboard:

- `DATABASE_URL` - Single database for platform and elizaOS tables
- `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WEBHOOK_SECRET`
- `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY`
- `BLOB_READ_WRITE_TOKEN` (optional, for media gallery)
- `FAL_KEY` (optional, for video generation)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (optional, for payments)
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optional, for container deployments)
- `ECS_CLUSTER_NAME`, `AWS_VPC_ID`, `AWS_SUBNET_IDS`, `AWS_SECURITY_GROUP_IDS` (for containers)
- `CRON_SECRET` (required for production)

Optional moderation config:

- `CONTENT_MODERATION_ENABLED=false` - disables async content moderation checks (the app will still stream responses).

**4. Update Privy Redirect URI**:

- Add production callback URL to Privy dashboard
- Configure allowed origins: `https://your-app.vercel.app`

**5. Deploy**:

- Click "Deploy"
- Vercel automatically builds and deploys
- Database migrations run on build

**6. Configure Stripe Webhook**:

- Add webhook endpoint in Stripe dashboard
- URL: `https://your-app.vercel.app/api/stripe/webhook`
- Select events: `checkout.session.completed`, `payment_intent.succeeded`

### Database Migrations in Production

Vercel runs migrations automatically via build script. For manual migration:

```bash
# Connect to production database
DATABASE_URL=postgres://prod-url npm run db:migrate
```

### Monitoring

- **Vercel Analytics**: Built-in (automatically enabled)
- **Logs**: View in Vercel dashboard
- **Error Tracking**: Console logs captured
- **Provider Health**: Check `/dashboard/analytics`

## 🐛 Troubleshooting

### Common Issues

#### 1. Database Connection Errors

**Error**: `Connection refused` or `SSL required`

**Solutions**:

- Verify `DATABASE_URL` includes `?sslmode=require`
- Check Neon dashboard for correct connection string
- Ensure database is not paused (serverless auto-pause)

#### 2. Authentication Issues

**Error**: Authentication errors or login failures

**Solutions**:

- Verify `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET` are correct
- Check allowed origins in Privy dashboard match your domain (e.g., `https://your-app.vercel.app`)
- Clear browser cookies and localStorage, then try again
- Ensure Privy webhook is configured: `https://your-domain.com/api/privy/webhook`
- Check webhook secret matches `PRIVY_WEBHOOK_SECRET` in your environment

#### 3. Environment Variables Not Loading

**Error**: `undefined` values in runtime

**Solutions**:

- Restart dev server after changing `.env.local`
- Ensure file is named exactly `.env.local` (not `.env`)
- Public variables must start with `NEXT_PUBLIC_`
- In production, verify all variables set in Vercel dashboard

#### 4. Container Deployment Fails

**Error**: "Container deployment failed" or "Deployment timeout"

**Solutions**:

- Check AWS credentials are correct: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Verify ECS configuration:
  - `ECS_CLUSTER_NAME` - cluster must exist or CloudFormation will create it
  - `AWS_VPC_ID` - must be a valid VPC ID
  - `AWS_SUBNET_IDS` - comma-separated subnet IDs in different AZs
  - `AWS_SECURITY_GROUP_IDS` - security group must allow HTTP/HTTPS ingress
  - `ECS_EXECUTION_ROLE_ARN` - IAM role for ECS task execution
- Test AWS credentials: `aws sts get-caller-identity`
- Check quota: `GET /api/v1/containers/quota`
- View logs in AWS CloudWatch or ECS console
- Ensure shared infrastructure is deployed: `cd scripts/cloudformation && ./deploy-shared.sh`

See `docs/DEPLOYMENT_TROUBLESHOOTING.md` for detailed troubleshooting.

#### 5. Docker Image Push Fails

**Error**: "Failed to push image to ECR" or "Authentication failed"

**Solutions**:

- Verify Docker is running: `docker info`
- Check AWS ECR credentials are valid
- Ensure image was built successfully: `docker images`
- Verify network connectivity to ECR
- Try re-authenticating: Request new credentials from `/api/v1/containers/credentials`

#### 6. Image/Video Generation Fails

**Error**: "No image/video was generated" or timeout

**Solutions**:

- **Image**: Verify Google Gemini access in AI Gateway or OpenAI API key
- **Video**: Check `FAL_KEY` is set correctly
- Try simpler prompts first
- Check rate limits in provider dashboard
- View error in `/dashboard/analytics`

#### 7. Credits Not Deducting

**Error**: Usage not tracking or credits not deducted

**Solutions**:

- Check `credit_transactions` table for records
- Verify organization `credit_balance` column
- Check for database transaction errors in logs
- Ensure `calculateCost()` is being called

#### 8. Stripe Webhook Not Working

**Error**: Credits not added after purchase

**Solutions**:

- Verify `STRIPE_WEBHOOK_SECRET` matches Stripe dashboard
- Check webhook endpoint URL is correct
- View webhook events in Stripe dashboard → Developers → Webhooks
- Test locally with Stripe CLI:
  ```bash
  stripe listen --forward-to localhost:3000/api/stripe/webhook
  ```

### Getting Help

- Check detailed docs in `/docs` folder
- [Next.js Documentation](https://nextjs.org/docs)
- [Drizzle ORM Docs](https://orm.drizzle.team/docs)
- [Privy Documentation](https://docs.privy.io)
- [Vercel AI SDK Docs](https://sdk.vercel.ai/docs)
- [elizaOS Documentation](https://github.com/elizaos/eliza)

## 🚀 AWS ECS Container Deployment

Deploy elizaOS agents to AWS ECS (Elastic Container Service) using Docker containers. Each user gets a dedicated EC2 instance (t4g.small ARM, Graviton2) managed via CloudFormation.

### Quick Start

```bash
# 1. Get your API key from the dashboard
# Visit https://your-domain.com/dashboard/api-keys

# 2. Set your API key
export ELIZAOS_API_KEY="your-api-key-here"

# 3. Ensure Docker is running locally
docker --version
docker info

# 4. Deploy your elizaOS project
cd your-elizaos-project
elizaos deploy
```

### How It Works

1. **CLI** requests ECR credentials from the cloud API
2. **CLI** builds Docker image locally
3. **CLI** pushes image to AWS ECR (Elastic Container Registry)
4. **CLI** creates container deployment via cloud API
5. **Cloud** deploys to dedicated EC2 instance (t4g.small ARM) with ECS
6. **Agent** runs on AWS with health checks and monitoring

### AWS Infrastructure Setup (Platform Maintainers)

**1. Deploy Shared Infrastructure**

The platform uses CloudFormation to provision per-user infrastructure. First, deploy shared resources:

```bash
cd scripts/cloudformation
./deploy-shared.sh
```

This creates:

- VPC with public subnets
- Application Load Balancer (ALB) for routing
- IAM roles for ECS tasks
- Security groups

**2. Configure Environment Variables**

```bash
# AWS Credentials
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret

# Network Configuration (from CloudFormation outputs)
AWS_VPC_ID=vpc-xxxxx
AWS_SUBNET_IDS=subnet-xxxxx,subnet-yyyyy
AWS_SECURITY_GROUP_IDS=sg-xxxxx

# ECS Configuration
ECS_CLUSTER_NAME=elizaos-production
ECS_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole
ECS_TASK_ROLE_ARN=arn:aws:iam::ACCOUNT:role/ecsTaskRole

# Optional: Shared ALB (recommended for cost savings)
ECS_SHARED_ALB_ARN=arn:aws:elasticloadbalancing:...
ECS_SHARED_LISTENER_ARN=arn:aws:elasticloadbalancing:...

# Environment (for stack naming)
ENVIRONMENT=production
```

**3. Start the Platform**

```bash
npm run dev  # Development
npm run build && npm start  # Production
```

Users can now deploy via: `elizaos deploy`

### For Users: Deployment Options

```bash
# Basic deployment
elizaos deploy

# With custom name and resources
elizaos deploy \
  --name my-agent \
  --port 8080 \
  --desired-count 2 \
  --cpu 512 \
  --memory 1024

# With environment variables
elizaos deploy \
  --env "OPENAI_API_KEY=sk-..." \
  --env "DATABASE_URL=postgresql://..."

# Using existing Docker image
elizaos deploy \
  --skip-build \
  --image-uri 123456789.dkr.ecr.us-east-1.amazonaws.com/my-project:v1.0.0
```

### Verification

```bash
# Check container status via API
curl https://elizacloud.ai/api/v1/containers \
  -H "Authorization: Bearer $ELIZAOS_API_KEY"

# View in dashboard
# https://elizacloud.ai/dashboard/containers
```

### Cost & Billing

Container deployments are billed **daily**:

- **Deployment**: $0.50 one-time per deployment
- **Running Costs**: $0.67/day per container (~$20/month)
  - Billed automatically at midnight UTC
  - 48-hour warning email sent when credits are low
  - Container shut down after 48 hours if no credits added

**Infrastructure** (managed by elizaOS Cloud):

- t4g.small (1.75 vCPU + 1.75 GB RAM) default instance type
- ECR image storage included
- Load balancing included
- Auto-scaling available for additional instances

**Daily Billing Behavior**:

1. CRON runs daily at midnight UTC
2. Charges $0.67 per running container
3. If insufficient credits: 48-hour shutdown warning email
4. If still insufficient after 48 hours: container stopped

---

---

## 📚 Additional Resources

### Core Framework

- [Next.js 15 Documentation](https://nextjs.org/docs)
- [React 19 Documentation](https://react.dev)
- [TypeScript Handbook](https://www.typescriptlang.org/docs)
- [Turbopack](https://turbo.build/pack)

### Database & ORM

- [Drizzle ORM Documentation](https://orm.drizzle.team)
- [Neon Serverless PostgreSQL](https://neon.tech/docs)
- [Drizzle Kit Guide](https://orm.drizzle.team/kit-docs/overview)
- [pgvector](https://github.com/pgvector/pgvector)

### AI & Machine Learning

- [Vercel AI SDK Documentation](https://sdk.vercel.ai/docs)
- [AI SDK Gateway Guide](https://sdk.vercel.ai/docs/ai-sdk-core/providers-and-models)
- [Google Gemini API](https://ai.google.dev/docs)
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [Anthropic Claude API](https://docs.anthropic.com)
- [Fal.ai Documentation](https://fal.ai/docs)
- [elizaOS Repository](https://github.com/elizaos/eliza)

### Authentication & Billing

- [Privy Authentication](https://docs.privy.io/guide/react/wallets/usage/overview)
- [Privy Webhooks](https://docs.privy.io/guide/server/webhooks)
- [Stripe API Documentation](https://stripe.com/docs/api)
- [Stripe Checkout](https://stripe.com/docs/payments/checkout)
- [Stripe Webhooks](https://stripe.com/docs/webhooks)

### Storage & Infrastructure

- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
- [Vercel Blob Pricing](https://vercel.com/docs/storage/vercel-blob/pricing)
- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [AWS ECR Documentation](https://docs.aws.amazon.com/ecr/)
- [AWS SDK for JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/)
- [AWS CloudFormation](https://docs.aws.amazon.com/cloudformation/)

### UI & Styling

- [Tailwind CSS v4 Documentation](https://tailwindcss.com/docs)
- [Radix UI Primitives](https://www.radix-ui.com/primitives)
- [Lucide Icons](https://lucide.dev)
- [next-themes Documentation](https://github.com/pacocoursey/next-themes)
- [Recharts](https://recharts.org/)

### Development Tools

- [ESLint](https://eslint.org/docs)
- [Prettier](https://prettier.io/docs)
- [Zod](https://zod.dev/)

## 📄 License

See the LICENSE file in the repository root.

---

**Built with ❤️ for the elizaOS ecosystem**
