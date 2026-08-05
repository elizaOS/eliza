# Onboarding — Account Setup, API Keys & Plans

## What This Covers

Getting users set up with Helius: creating accounts, obtaining API keys, understanding plans, and managing billing. There are three paths to get an API key, plus SDK-based signup for applications.

## MCP Tools

| MCP Tool | What It Does |
|---|---|
| `setHeliusApiKey` | Configure an existing API key for the session (validates against `getBlockHeight`) |
| `generateKeypair` | Generate or load a Solana keypair for signup (persists to `~/.helius/keypair.json`) |
| `signup` | Create a Helius account via hosted payment link (`mode: "link"`), or pay USDC directly from the local keypair (`mode: "autopay"`), or finalize a previously-created intent (`mode: "resume"`) |
| `getAccountStatus` | Check current plan, credits remaining, rate limits, billing cycle, burn-rate projections |
| `getHeliusPlanInfo` | View plan details — pricing, credits, rate limits, features |
| `compareHeliusPlans` | Compare plans side-by-side by category (rates, features, connections, pricing, support) |
| `previewUpgrade` | Preview upgrade pricing with proration before committing |
| `upgradePlan` | Execute a plan upgrade (returns a hosted payment link or pays USDC directly) |
| `payRenewal` | Pay a renewal payment intent |
| `purchaseCredits` | Buy prepaid credits (link or autopay) |

## Getting an API Key

### Path A: Existing Key (Fastest)

If the user already has a Helius API key from the dashboard:

1. Use the `setHeliusApiKey` MCP tool with their key
2. The tool validates the key against `getBlockHeight`, then persists it to shared config
3. All Helius MCP tools are immediately available

If the environment variable `HELIUS_API_KEY` is already set, no action is needed — tools auto-detect it.

### Path B: MCP Signup (For AI Agents)

Two modes — pick based on whether the user wants to pay in a browser or have the agent pay USDC from a local keypair.

**Link mode (default — pay in browser):**

1. **`generateKeypair`** — generates or loads a Solana keypair. Returns the wallet address.
2. **`signup`** with `mode: "link"` — creates a payment intent and returns a `paymentUrl` (e.g. `https://dashboard.helius.dev/pay/<id>`). The user opens that URL in any browser and pays with any wallet. The pending intent is persisted to shared config.
3. **`signup`** with `mode: "resume"` — polls the intent, finalizes account provisioning, and configures the API key automatically once payment settles.

**Autopay mode (agent pays USDC from local keypair):**

1. **`generateKeypair`** — same as above.
2. **User funds the wallet** with ~0.001 SOL (transaction fees) + the plan amount in USDC ($1 Agent, $49 Developer, $499 Business, $999 Professional).
3. **`signup`** with `mode: "autopay"` — sends USDC + memo from the local keypair, polls until the subscription is provisioned, returns API key + RPC endpoints + project ID.

If the wallet already has an account on the same plan, `signup` detects it and returns existing credentials (no double payment). If it's on a different plan, `signup` returns `kind: "upgrade_required"` — use `upgradePlan` instead.

**Parameters for `signup`:**
- `mode`: `"link"` (default), `"autopay"`, or `"resume"`
- `plan`: `"agent"` (default, $1), `"developer"`, `"business"`, or `"professional"`
- `period`: `"monthly"` (default) or `"yearly"` (paid plans only)
- `email`, `firstName`, `lastName`: required for every new signup
- `couponCode`: optional discount code

### Path C: Helius CLI

The `helius-cli` provides the same flow from the terminal:

```bash
# Generate keypair (saved to ~/.helius/keypair.json)
helius keygen

# Print a hosted payment link (default)
helius signup --plan agent --email me@example.com --first-name Ada --last-name Lovelace --json

# Pay in the browser, then finalize:
helius signup --resume --json

# Or autopay USDC directly from the local keypair:
helius signup --plan agent --email me@example.com --first-name Ada --last-name Lovelace --pay --json

# Discard a stuck pending intent and start over:
helius signup --restart --plan agent ...

# List projects and get API keys
helius projects --json
helius apikeys <project-id> --json

# Get RPC endpoints
helius rpc <project-id> --json
```

**CLI exit codes** (for error handling in scripts):
- `0`: success
- `10`: not logged in (run `helius login`)
- `11`: keypair not found (run `helius keygen`)
- `20`: insufficient SOL (autopay only)
- `21`: insufficient USDC (autopay only)

Always use the `--json` flag for machine-readable output when scripting.

### SDK In-Process Signup

For applications that need to create Helius accounts programmatically:

```typescript
import { makeAuthClient } from "helius-sdk/auth/client";
const auth = makeAuthClient();

const keypair = await auth.generateKeypair();

// Hosted-link signup (returns a paymentUrl the user opens in a browser):
const link = await auth.signup({
  secretKey: keypair.secretKey,
  plan: "developer",
  period: "monthly",
  email: "user@example.com",
  firstName: "Jane",
  lastName: "Doe",
});
// link.paymentLink.paymentUrl — open this in a browser

// Or pay USDC directly from the local keypair:
const result = await auth.signupAndPay({
  secretKey: keypair.secretKey,
  plan: "developer",
  period: "monthly",
  email: "user@example.com",
  firstName: "Jane",
  lastName: "Doe",
});
// result.kind: "completed" | "pending" | "expired" | "failed" | "already_subscribed" | "upgrade_required"
// On "completed": result has { jwt, walletAddress, projectId, apiKey, endpoints, txSignature }
```

## Plans and Pricing

| | Agent | Developer | Business | Professional |
|---|---|---|---|---|
| **Price** | $1 USDC | $49/mo | $499/mo | $999/mo |
| **Credits** | 1M | 10M | 100M | 200M |
| **Extra credits** | N/A | $5/M | $5/M | $5/M |
| **RPC RPS** | 10 | 50 | 200 | 500 |
| **sendTransaction** | 1/s | 5/s | 50/s | 100/s |
| **DAS** | 2/s | 10/s | 50/s | 100/s |
| **WS connections** | 5 | 150 | 250 | 1,000 |
| **Enhanced WS** | No | 150 conn | 250 conn | 1,000 conn |
| **LaserStream** | No | Devnet | Devnet + Mainnet | Devnet + Mainnet |
| **Support** | Discord | Chat (24hr) | Priority (12hr) | Slack + Telegram (8hr) |

### Credit Costs

- **0 credits**: Helius Sender (sendSmartTransaction, sendJitoBundle)
- **1 credit**: Standard RPC calls, sendTransaction, Priority Fee API, webhook events
- **2 credits**: per 0.1 MB streamed (LaserStream, Enhanced WebSockets, Standard WebSockets)
- **10 credits**: getProgramAccounts, DAS API, historical data
- **100 credits**: Enhanced Transactions API, Wallet API, webhook management

### Feature Availability by Plan

| Feature | Minimum Plan |
|---|---|
| Standard RPC, DAS, Webhooks, Sender | Agent |
| Standard WebSockets | Agent |
| Enhanced WebSockets | Developer |
| LaserStream (devnet) | Developer |
| LaserStream (mainnet) | Business |
| LaserStream data add-ons | Business+ ($400+/mo) |

Use the `getHeliusPlanInfo` or `compareHeliusPlans` MCP tools for current details.

## Managing Accounts

### Check Account Status

The `getAccountStatus` tool provides three tiers of information:

1. **No auth**: Tells the user how to get started (set key or sign up)
2. **API key only** (no JWT): Confirms auth but can't show credit usage — suggests calling `signup` to detect existing account
3. **Full JWT session**: Shows plan, rate limits, credit usage breakdown (API/RPC/webhooks/overage), billing cycle with days remaining, and burn-rate projections with warnings

Call `getAccountStatus` before bulk operations to verify sufficient credits.

### Upgrade Plans

1. **`previewUpgrade`** — shows pricing breakdown: subtotal, prorated credits, discounts, coupon status, amount due today
2. **`upgradePlan`** — returns a hosted payment link by default, or pays USDC directly with `mode: "autopay"`
   - Requires `email`, `firstName`, `lastName` for first-time upgrades (all three or none)
   - Supports `couponCode` for discounts

### Pay Renewals

`payRenewal` takes a `paymentIntentId` from a renewal notification and either prints a payment link or pays USDC directly.

## Environment Configuration

```bash
# Required — set one of these:
HELIUS_API_KEY=your-api-key          # Environment variable
# OR use setHeliusApiKey MCP tool    # Session + shared config
# OR use signup                      # Auto-configures

# Optional
HELIUS_NETWORK=mainnet-beta          # or devnet (default: mainnet-beta)
HELIUS_PAYMENT_HOST=https://dashboard.helius.dev   # override hosted-link host (e.g. staging)
```

### Shared Config

The MCP persists API keys and JWTs to shared config files so they survive across sessions:
- **API key**: saved to shared config path (accessible by both MCP and CLI)
- **Keypair**: saved to `~/.helius/keypair.json`
- **JWT**: saved to shared config for authenticated session features
- **Pending payment intent**: link-mode signup persists the pending intent so `mode: "resume"` (or `helius signup --resume`) can finalize after the user pays in the browser

### Installing the MCP

```bash
npx helius-mcp@latest  # configure in .clawd/settings.json or your MCP client
```

## Choosing the Right Setup Path

| Scenario | Path |
|---|---|
| User has a Helius API key | `setHeliusApiKey` (Path A) |
| User has `HELIUS_API_KEY` env var set | No action needed — auto-detected |
| AI agent + user wants to pay in browser | `generateKeypair` -> `signup` (link) -> user pays -> `signup` (resume) (Path B) |
| AI agent + agent pays USDC from local keypair | `generateKeypair` -> fund wallet -> `signup` (autopay) (Path B) |
| Script/CI link-mode signup | `helius keygen` -> `helius signup --json` -> user pays -> `helius signup --resume --json` (Path C) |
| Script/CI autopay signup | `helius keygen` -> fund -> `helius signup --pay --json` (Path C) |
| Application needs programmatic signup | SDK `signup()` / `signupAndPay()` |
| User wants full account visibility | `signup` (detects existing accounts) then `getAccountStatus` |
| User needs a higher plan | `previewUpgrade` then `upgradePlan` |

## Common Mistakes

- Calling `signup` without first calling `generateKeypair` — there's no wallet to sign with
- Calling `signup` with `mode: "autopay"` before funding the wallet — the USDC payment will fail
- Assuming `signup` charges twice for existing accounts — it detects and returns existing credentials
- Using `getAccountStatus` without a JWT session — call `signup` first to establish the session (it detects existing accounts for free)
- Forgetting that every new signup requires `email`, `firstName`, and `lastName` — all three are required together
- After a link-mode signup, forgetting to call `mode: "resume"` (or `helius signup --resume`) — the account isn't provisioned until polling completes
