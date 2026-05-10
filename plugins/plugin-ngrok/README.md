# @elizaos/plugin-ngrok

<img src="images/banner.jpg" alt="Plugin Ngrok Banner" width="100%" />

A powerful ngrok tunnel plugin for ElizaOS that enables agents to expose local services to the internet with a production-ready dashboard.

## Features

- 🌐 **Expose Local Services**: Create secure HTTPS tunnels to your local servers
- 📊 **Web Dashboard**: Real-time monitoring and management of active tunnels
- 🔧 **Full API**: RESTful API for programmatic tunnel management
- 🧪 **100% Test Coverage**: Comprehensive unit, integration, E2E, and Cypress tests
- 🎯 **TypeScript**: Fully typed for excellent developer experience
- 🔒 **Secure**: Built-in auth token support and secure tunnel management

## Installation

```bash
npm install @elizaos/plugin-ngrok
```

## Quick Start

1. **Get your ngrok auth token** (optional but recommended):

   - Visit [ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)
   - Sign up for a free account
   - Copy your auth token

2. **Configure your environment**:

   ```bash
   # .env file
   NGROK_AUTH_TOKEN=your_auth_token_here  # Optional but recommended
   NGROK_REGION=us                         # Optional: us, eu, ap, au, sa, jp, in
   NGROK_SUBDOMAIN=my-app                  # Optional: requires paid plan
   ```

3. **Use in your agent**:

   ```typescript
   import ngrokPlugin from '@elizaos/plugin-ngrok';

   const agent = new Agent({
     plugins: [ngrokPlugin],
     // ... other config
   });
   ```

## Web Dashboard

The plugin includes a beautiful, production-ready web dashboard for managing your tunnels.

### Running the Dashboard

```bash
# Start both API server and dashboard
npm run demo:full

# Or run them separately:
npm run demo:api   # Start API server on port 3001
npm run dev        # Start dashboard on port 5173
```

Visit http://localhost:5173 to access the dashboard.

### Dashboard Features

- **Real-time Status**: Monitor active tunnels with live updates
- **Easy Management**: Start/stop tunnels with a single click
- **Configuration**: Set port, region, and custom subdomains
- **Copy URL**: Quick copy button for sharing tunnel URLs
- **Responsive Design**: Works perfectly on desktop and mobile
- **Auto-refresh**: Status updates every 5 seconds

## Available Actions

The plugin provides three main actions:

### START_TUNNEL

Starts a new ngrok tunnel on the specified port.

```typescript
// Example usage in agent
'Can you start a tunnel on port 3000?';
'Open ngrok on port 8080 in the EU region';
"Create a tunnel with subdomain 'my-app' on port 3000";
```

### STOP_TUNNEL

Stops the currently active tunnel.

```typescript
'Stop the tunnel';
'Close ngrok';
'Shutdown the tunnel';
```

### GET_TUNNEL_STATUS

Gets the current status of the tunnel.

```typescript
"What's the tunnel status?";
'Is ngrok running?';
'Show me the tunnel URL';
```

## Testing

This plugin includes comprehensive test coverage across multiple test types:

### Run All Tests

```bash
# Run all plugin tests (unit + E2E)
npm test

# Run with coverage report
npm run test:coverage
```

### Unit Tests

```bash
# Run unit tests only
npm run test:unit

# Run in watch mode
npm run test:watch
```

### Integration Tests

```bash
# Run integration tests (requires ngrok installed)
npm run test:integration
```

### E2E Tests

```bash
# Run E2E tests (uses real ngrok API)
npm run test:e2e
```

### Cypress Tests

```bash
# Run Cypress tests headlessly
npm run test:cypress

# Open Cypress interactive mode
npm run cypress:open
```

## API Reference

### REST API Endpoints

The plugin includes an Express API server for the dashboard:

#### GET /api/tunnel/status

Returns the current tunnel status.

**Response:**

```json
{
  "active": true,
  "url": "https://abc123.ngrok.io",
  "port": 3000,
  "startedAt": "2024-01-01T00:00:00.000Z",
  "provider": "ngrok",
  "uptime": "15 minutes"
}
```

#### POST /api/tunnel/start

Starts a new tunnel.

**Request Body:**

```json
{
  "port": 3000,
  "region": "eu", // optional
  "subdomain": "my-app" // optional, requires paid plan
}
```

#### POST /api/tunnel/stop

Stops the active tunnel.

### TypeScript Types

```typescript
interface TunnelStatus {
  active: boolean;
  url: string | null;
  port: number | null;
  startedAt: Date | null;
  provider: string;
}

interface TunnelConfig {
  provider?: 'ngrok' | 'cloudflare' | 'localtunnel';
  authToken?: string;
  region?: string;
  subdomain?: string;
}

interface ITunnelService {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
  isActive(): boolean;
  getStatus(): TunnelStatus;
}
```

## Development

### Project Structure

```
plugin-ngrok/
├── src/
│   ├── actions/          # Agent actions
│   ├── services/         # NgrokService implementation
│   ├── types/            # TypeScript types
│   ├── frontend/         # React dashboard
│   └── __tests__/        # Test suites
├── demo/                 # Demo applications
├── cypress/              # Cypress E2E tests
└── dist/                 # Build output
```

### Building

```bash
# Build plugin and dashboard
npm run build

# Build plugin only
tsup src/index.ts --format esm --dts

# Build dashboard only
vite build
```

### Development Mode

```bash
# Watch plugin changes
npm run dev:plugin

# Run dashboard dev server
npm run dev

# Run everything in dev mode
npm run demo:full
```

## Environment Variables

| Variable             | Description                                | Default | Required             |
| -------------------- | ------------------------------------------ | ------- | -------------------- |
| `NGROK_AUTH_TOKEN`   | Your ngrok authentication token            | -       | No (but recommended) |
| `NGROK_REGION`       | Tunnel region (us, eu, ap, au, sa, jp, in) | us      | No                   |
| `NGROK_SUBDOMAIN`    | Custom subdomain (requires paid plan)      | -       | No                   |
| `NGROK_DEFAULT_PORT` | Default port for tunnels                   | 3000    | No                   |
| `API_PORT`           | Port for the API server                    | 3001    | No                   |

## Troubleshooting

### Ngrok not installed

If you see "ngrok is not installed", install it using:

```bash
# macOS
brew install ngrok

# Linux
snap install ngrok

# Windows
choco install ngrok
```

### Auth token issues

Without an auth token, tunnels will have limited functionality. Get a free token at [ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken).

### Port already in use

Make sure the port you're trying to tunnel is actually running a service and is not blocked by a firewall.

## Contributing

Contributions are welcome! Please ensure all tests pass and add tests for new features:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Write tests for your changes
4. Ensure all tests pass (`npm test`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

This plugin is part of the ElizaOS project. See the main project for license information.

## Support

For issues and feature requests, please use the GitHub issue tracker.

For questions and discussions, join the ElizaOS community on Discord.
