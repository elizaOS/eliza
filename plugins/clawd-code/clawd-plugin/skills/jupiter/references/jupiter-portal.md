# Jupiter Portal — API Keys & Rate Limits

## What This Covers

Jupiter API key setup, authentication requirements, and rate limiting behavior for all Jupiter REST endpoints.

---

## Getting an API Key

All Jupiter REST endpoints require authentication via the `x-api-key` header.

1. Go to [developers.jup.ag/portal](https://developers.jup.ag/portal)
2. Sign in with your email
3. Generate an API key
4. Store it securely — never commit to git

### Using the API Key

```typescript
const headers = {
  'x-api-key': process.env.JUPITER_API_KEY!,
  'Content-Type': 'application/json',
};

const response = await fetch('https://api.jup.ag/swap/v2/order?inputMint=...&outputMint=...&amount=...&taker=...', {
  headers,
});
```

### Environment Variable Setup

```bash
export JUPITER_API_KEY=your-api-key-here
```

---

## Base URL

All Jupiter API endpoints use:

```
https://api.jup.ag
```

---

## Rate Limits

### Swap API — Dynamic Rate Limits

Swap API rate limits scale dynamically based on your 24-hour execute volume:

| 24h Execute Volume | Rate Limit |
|---|---|
| $0 | 50 req/10s |
| $10,000 | 51 req/10s |
| $100,000 | 61 req/10s |
| $1,000,000 | 165 req/10s |

Rate limits increase as you drive more volume through the API.

### Other APIs

Most other Jupiter APIs use standard rate limits. Check the specific API documentation for exact limits.

### Handling Rate Limits (HTTP 429)

When you receive a 429 response, implement exponential backoff with jitter:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429 && attempt < maxRetries) {
      const baseDelay = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      await new Promise(r => setTimeout(r, baseDelay + jitter));
      continue;
    }

    return response;
  }
  throw new Error('Max retries exceeded');
}
```

---

## Authentication Invariant

**Hard rule**: Never call a Jupiter REST endpoint without the `x-api-key` header. If the user hasn't configured a key, stop and ask them to set one up at [developers.jup.ag/portal](https://developers.jup.ag/portal) before proceeding.

---

## API Families

Jupiter provides these API families, all under `https://api.jup.ag`:

| API | Path Prefix | Purpose |
|---|---|---|
| Swap API V2 | `/swap/v2` | Token swaps with optimized routing |
| Trigger V2 | `/trigger/v2` | Limit orders (JWT auth, vault deposits, OCO/OTOCO) |
| Recurring | `/recurring/v1` | DCA orders |
| Tokens | `/tokens/v2` | Token search and metadata |
| Price | `/price/v3` | Token prices |
| Portfolio | `/portfolio/v1` | Position tracking (beta) |
| Prediction Markets | `/prediction/v1` | Event markets (beta, geo-restricted) |
| Send | `/send/v1` | Token transfers (beta) |
| Studio | `/studio/v1` | Token creation (beta) |
| Lend (REST) | `/lend/v1` | Lending operations |

### Beta APIs

Portfolio, Prediction Markets, Send, and Studio are currently in beta. Their interfaces may change.

### On-Chain Only

- **Perps**: No REST API yet — on-chain Anchor IDL only
- **Lock**: On-chain vesting program (audited by OtterSec and Sec3)

---

## Resources

- Jupiter Portal: [developers.jup.ag/portal](https://developers.jup.ag/portal)
- Jupiter Docs: [dev.jup.ag](https://dev.jup.ag/)
- LLM-Optimized Docs: [dev.jup.ag/docs/llms.txt](https://dev.jup.ag/docs/llms.txt)
