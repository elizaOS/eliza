# Eliza Chat Interface

A clean, modern chat interface for interacting with Eliza AI agents using Next.js, shadcn/ui, and the Vercel AI SDK.

## Features

- 🚀 Real-time streaming responses
- 💬 Clean, responsive chat UI
- 🎨 Built with shadcn/ui components
- ⚡ Powered by Vercel AI SDK's useChat hook
- 🔄 Seamless integration with Eliza server API

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- Eliza server running (default: http://localhost:3000)

### Installation

Install dependencies:

```bash
bun install
```

### Configuration

Create a `.env.local` file in the root directory:

```env
# The URL where your Eliza server is running
NEXT_PUBLIC_ELIZA_API_URL=http://localhost:3000/v1

# Optional: API key if your Eliza server requires authentication
ELIZA_API_KEY=

# Optional: Default agent ID to use
NEXT_PUBLIC_DEFAULT_AGENT_ID=default
```

### Running the Development Server

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) to start chatting with your Eliza agents.

## Project Structure

```
gui/
├── app/
│   ├── api/
│   │   └── chat/
│   │       └── route.ts      # API route that proxies to Eliza server
│   ├── layout.tsx
│   └── page.tsx              # Main chat page
├── components/
│   ├── chat.tsx              # Main chat component with useChat
│   └── ui/                   # shadcn/ui components
│       ├── button.tsx
│       ├── card.tsx
│       ├── input.tsx
│       └── scroll-area.tsx
└── lib/
    └── utils.ts              # Utility functions
```

## How It Works

1. **Chat Component**: Uses the `useChat` hook from Vercel AI SDK to handle streaming responses
2. **API Route**: Proxies requests to the Eliza server's `/v1/chat/completions` endpoint
3. **Streaming**: Supports real-time streaming of AI responses for a smooth UX
4. **Agent Selection**: Pass different agent IDs to chat with different Eliza agents

## Customization

### Changing the Agent

You can specify a different agent by modifying the `agentId` prop in `app/page.tsx`:

```tsx
<Chat agentId="your-agent-id" agentName="Your Agent Name" />
```

### Styling

The interface uses Tailwind CSS and shadcn/ui components. Customize the theme in:
- `app/globals.css` - CSS variables and theme configuration
- `tailwind.config.js` - Tailwind configuration

## API Integration

The chat interface integrates with the Eliza server's completions API:

- **Endpoint**: `POST /v1/chat/completions`
- **Streaming**: Supported via Server-Sent Events (SSE)
- **Agent Selection**: Pass `agentId` as a query parameter

## Troubleshooting

### Connection Issues

If you can't connect to the Eliza server:
1. Ensure the Eliza server is running
2. Check the `NEXT_PUBLIC_ELIZA_API_URL` in your `.env.local`
3. Verify CORS settings on the Eliza server

### Streaming Not Working

1. Ensure your Eliza server supports streaming responses
2. Check that the API route is properly configured
3. Verify the response format matches the AI SDK expectations

## License

This project is part of the Eliza ecosystem.