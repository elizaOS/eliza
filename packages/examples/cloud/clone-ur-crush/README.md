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

# Affiliate API key with "affiliate:create-character" permission (required for
# character creation). SERVER-ONLY — not NEXT_PUBLIC, so it is never inlined
# into the client bundle. Read by the /api/affiliate/create-character route.
AFFILIATE_API_KEY=eliza_your_affiliate_api_key
```

## Architecture

### Flow

1. **Landing Page** (`/`) - User creates character with description, photo, and conversation examples
2. **Cloning Page** (`/cloning`) - Shows animation while creating character in ElizaOS Cloud
3. **Redirect** - Takes user to ElizaOS Cloud chat interface with their new character

### Integration with ElizaOS Cloud

Character creation goes through a same-origin server route
(`app/api/affiliate/create-character`) that attaches the server-only
`AFFILIATE_API_KEY` and forwards to the ElizaOS Cloud Affiliate API. The
privileged key never reaches the browser:

```typescript
// browser → same-origin proxy → ElizaOS Cloud
POST /api/affiliate/create-character
{
  character: ElizaOSCharacter,
  affiliateId: 'clone-your-crush',
  sessionId: string
}
```

### Application guest sessions & billing

Visitors create and chat with their character **without signing up** — they get
an anonymous *application guest session*. That guest's usage (inference) is
billed to the **credits of the application owner**: whoever owns the
`AFFILIATE_API_KEY`. The guest user and character are created inside the API
key owner's organization, so every message deducts the owner's `credit_balance`,
capped per session by `ANON_MESSAGE_LIMIT` (default 5). Keep the owner
organization funded; when its balance is exhausted, guest inference fails with
an insufficient-credits error (character creation still succeeds).

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Runtime**: Bun
- **Styling**: Tailwind CSS
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
│   │   ├── affiliate/
│   │   │   └── create-character/ # server-side proxy (holds the affiliate key)
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
