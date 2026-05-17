# Domain Buy API Shape

Use these routes through `USE_SKILL parent-agent` when you are an orchestrated
worker. Use `ELIZAOS_CLOUD_API_KEY` only in the parent/app runtime where
credentials are already provisioned. The SDK methods are wrappers around the
same endpoints.

## Quote A Domain

`POST /api/v1/apps/{appId}/domains/check`

```json
{ "domain": "myapp.com" }
```

Success response:

```json
{
  "success": true,
  "domain": "myapp.com",
  "available": true,
  "currency": "USD",
  "years": 1,
  "price": {
    "wholesaleUsdCents": 1099,
    "marginUsdCents": 396,
    "totalUsdCents": 1495,
    "marginBps": 3600
  }
}
```

If `available` is false, ask for another domain. Do not call buy.

## Buy A Domain

`POST /api/v1/apps/{appId}/domains/buy`

```json
{ "domain": "myapp.com" }
```

Success response:

```json
{
  "success": true,
  "domain": "myapp.com",
  "appDomainId": "uuid",
  "zoneId": "cloudflare-zone-id",
  "status": "active",
  "verified": true,
  "expiresAt": "2027-05-04T00:00:00.000Z",
  "pendingZoneProvisioning": false,
  "alreadyRegistered": false,
  "debited": {
    "totalUsdCents": 1495,
    "currency": "USD"
  }
}
```

The route is idempotent for domains already owned by the same organization. If
`alreadyRegistered` is true, report that no second registration charge was
needed unless the response includes a new `debited` object.

## Search Suggestions

`POST /api/v1/domains/search`

```json
{ "query": "myapp", "limit": 5 }
```

Use this after an app build to offer one or two options. Prefer `.com`,
`.io`, `.dev`, and `.app`, sorted by total yearly price.
