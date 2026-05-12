# DNS And SSL After Buying

When `/domains/buy` succeeds, Cloud owns the registration through Cloudflare and
attaches the domain to the app. If Cloudflare has already provisioned a zone,
the API also creates or updates the apex record to point at the app target.

Expected states:

- `status: "active"` and `verified: true`: the domain is registered and ready
  from Cloud's perspective.
- `pendingZoneProvisioning: true`: registration succeeded, but the Cloudflare
  zone id was not available yet. Retry `/domains/buy`, `/domains/status`, or
  `/domains/sync` later. Do not buy a different domain unless the user asks.
- HTTPS may take a minute or two after DNS appears because edge certificates
  need to provision.

For status verification, prefer direct checks:

```bash
curl -I "https://myapp.com/"
dig +short myapp.com
```

Do not use registrar search pages or web snippets to decide whether a domain
was bought. Use the Cloud API and direct DNS/HTTP checks.
