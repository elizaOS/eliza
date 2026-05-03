# Clone Your Crush

An AI-powered web app that lets you create an AI clone of your crush and chat with them using ElizaOS.

## Features

- 💕 Create AI character clones with personality descriptions
- 🎨 Upload or generate character photos with AI
- 💬 Seamless integration with ElizaOS Cloud for chat
- 📱 Fully responsive and mobile-friendly design
- ✨ Beautiful gradient UI with modern animations
- 🔗 Powered by [Eliza Labs](https://elizaos.ai)

## Development (Standalone)

From the `clone-your-crush` directory:

```bash
# Install dependencies
bun install

# Start development server (port 3005)
bun run dev

# Run tests
bun run test

# Build for production
bun run build
```

## Development (With Cloud)

From the `vendor/cloud` directory:

```bash
# Start both Cloud and Crush together
bun run crush

# This will start:
# - ElizaOS Cloud on http://localhost:3000
# - Fake Girlfriend on http://localhost:3012

# Run e2e tests (starts both services and runs tests)
bun run crush:test
```

## Environment Variables

Required in `.env` or `.env.local`:

```env
# ElizaOS Cloud URL (defaults to http://localhost:3000)
NEXT_PUBLIC_ELIZA_CLOUD_URL=http://localhost:3000

# App URL (defaults to http://localhost:3012)
NEXT_PUBLIC_APP_URL=http://localhost:3012

# Privy App ID (for authentication)
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id

# Affiliate API key with "affiliate:create-character" permission (required for character creation)
NEXT_PUBLIC_AFFILIATE_API_KEY=eliza_your_affiliate_api_key
```

## Architecture

### Flow

1. **Landing Page** (`/`) - User creates character with description, photo, and conversation examples
2. **Cloning Page** (`/cloning`) - Shows animation while creating character in ElizaOS Cloud
3. **Redirect** - Takes user to ElizaOS Cloud chat interface with their new character

### Integration with ElizaOS Cloud

The app uses the ElizaOS Cloud Affiliate API:

```typescript
POST /api/affiliate/create-character
{
  character: ElizaOSCharacter,
  affiliateId: 'clone-your-crush',
  sessionId: string
}
```

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Runtime**: Bun
- **Styling**: Tailwind CSS
- **Authentication**: Privy
- **AI Integration**: ElizaOS Cloud API
- **Testing**: Playwright + Synpress

## Testing

```bash
# Run all Playwright tests
bun run test

# Run with UI
bun run test --ui

# Run in headed mode
bun run test --headed

# Run specific test file
bun run test tests/playwright/homepage.spec.ts
```

### Test Coverage

- ✅ Homepage rendering and form validation
- ✅ Photo upload and generation UI
- ✅ Form submission and navigation
- ✅ Cloning page animation
- ✅ Error handling and redirects
- ✅ Eliza Labs branding
- ✅ Mobile responsiveness
- ✅ Cloud integration

## Directory Structure

```
clone-your-crush/
├── app/
│   ├── api/              # API routes
│   │   ├── analyze-photo/
│   │   ├── create-character/
│   │   ├── generate-field/
│   │   └── generate-photo/
│   ├── cloning/          # Cloning animation page
│   ├── globals.css       # Global styles
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Landing page
├── lib/
│   ├── constants.ts      # App configuration
│   └── utils.ts          # Utility functions
├── providers/
│   └── PrivyProvider.tsx # Auth provider
├── tests/
│   ├── playwright/       # Playwright tests
│   └── synpress/         # Wallet integration tests
└── types/
    └── index.ts          # TypeScript types
```

## Contributing

1. Make changes to the code
2. Run tests: `bun run test`
3. Ensure all tests pass
4. Update tests if adding new features

## License

MIT
