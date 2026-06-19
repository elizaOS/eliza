# DNS Record Guidance

Cloudflare-managed zones support these record types through Cloud:

- `A`: hostname to IPv4 address.
- `AAAA`: hostname to IPv6 address.
- `CNAME`: hostname alias to another hostname.
- `TXT`: text records, including verification records.
- `MX`: mail exchanger. Requires `priority`.
- `SRV`: service records.
- `CAA`: certificate authority authorization.

Use `ttl: 1` for Cloudflare automatic TTL unless the user asks for a fixed TTL.
Use `proxied: true` for web traffic that should pass through Cloudflare. Do not
proxy records that are not HTTP-facing unless the user knows what they are
doing.

For apex app hosting, prefer the Cloud API's automatic setup from `/domains/buy`
or `/domains/sync`. Do not manually overwrite apex records unless the user asked
for a DNS edit.

For destructive DNS edits:

1. List current records first.
2. Show the exact record name/type/content that will change.
3. Ask for explicit confirmation before delete or broad replacement.
