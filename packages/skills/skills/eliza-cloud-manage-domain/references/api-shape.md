# Domain Management API Shape

Use these routes after a domain is already attached to an app.

## List Domains

Org-wide:

`GET /api/v1/domains`

Per app:

`GET /api/v1/apps/{appId}/domains`

## External Domain Attach

For a domain the user already owns elsewhere:

`POST /api/v1/apps/{appId}/domains`

```json
{ "domain": "myapp.com" }
```

Cloud returns a verification TXT challenge. The user adds it at their DNS
provider, then you call verify.

## Verify Or Sync

`POST /api/v1/apps/{appId}/domains/verify`

```json
{ "domain": "myapp.com" }
```

`POST /api/v1/apps/{appId}/domains/status`

```json
{ "domain": "myapp.com" }
```

`POST /api/v1/apps/{appId}/domains/sync`

No body required. Refreshes Cloudflare-backed domain metadata for the app.

## DNS Records

List:

`GET /api/v1/apps/{appId}/domains/{domain}/dns`

Create:

`POST /api/v1/apps/{appId}/domains/{domain}/dns`

```json
{ "type": "CNAME", "name": "www", "content": "target.example.com", "ttl": 1, "proxied": true }
```

Update:

`PATCH /api/v1/apps/{appId}/domains/{domain}/dns/{recordId}`

```json
{ "content": "203.0.113.10", "ttl": 300 }
```

Delete:

`DELETE /api/v1/apps/{appId}/domains/{domain}/dns/{recordId}`

DNS CRUD only works for Cloudflare-registered domains managed by Cloud.
External domains return 409 and must be edited at the user's DNS provider.
