# tunnel-proxy

Railway service for public Eliza Cloud tunnel URLs.

The service joins the Headscale tailnet with `tsnet` as `tag:eliza-proxy`.
Railway terminates public TLS for `tunnel.eliza.app` and
`*.tunnel.eliza.app`, then this proxy maps
the public host to the matching Headscale MagicDNS host:

```text
eliza-<org>-<random>.tunnel.eliza.app -> https://eliza-<org>-<random>.tunnel.eliza.local
```

Only Cloud-minted hostnames matching
`eliza-<orgpart>-<randomhex>-<expiry>-<signature>` are proxied when
`TUNNEL_HOSTNAME_SIGNING_SECRET` is set. Root traffic and arbitrary wildcard
labels return 404, while `/health` and `/ready` remain public for Railway and
DNS smoke checks.

Required Railway environment variables:

| Variable                         | Value                                                   |
| -------------------------------- | ------------------------------------------------------- |
| `HEADSCALE_PUBLIC_URL`           | `https://headscale.eliza.app`                           |
| `TUNNEL_PROXY_TS_AUTHKEY`        | reusable Headscale preauth key tagged `tag:eliza-proxy` |
| `TUNNEL_PROXY_HOST`              | `tunnel.eliza.app`                                      |
| `TUNNEL_TAILNET_DOMAIN`          | `tunnel.eliza.local`                                    |
| `TUNNEL_HOSTNAME_SIGNING_SECRET` | shared HMAC secret also set as a Cloud Worker secret    |

Mount a Railway volume at `/var/lib/tunnel-proxy` so the `tsnet` node identity
persists across restarts.

## Protected deployment

Use `.github/workflows/deploy-tunnel-proxy.yml` for staging or production. The
selected GitHub Environment must define these variables:

- `HEADSCALE_PUBLIC_URL` — exactly `https://headscale-staging.eliza.app` or
  `https://headscale.eliza.app`;
- `TUNNEL_PROXY_HOST` — exactly `tunnel-staging.eliza.app` or
  `tunnel.eliza.app`;
- `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and
  `RAILWAY_SERVICE_ID_TUNNEL_PROXY` — the existing Railway `tunnel-proxy`
  target.

It must also define `RAILWAY_TOKEN`, `ELIZA_PROVISIONING_HOST`,
`ELIZA_PROVISIONING_SSH_KEY`, `ELIZA_PROVISIONING_SSH_KNOWN_HOSTS`, and
`TUNNEL_HOSTNAME_SIGNING_SECRET` as secrets. The known-hosts value must contain
the independently verified SSH host key for `ELIZA_PROVISIONING_HOST`; the
workflow does not trust a key learned during the deploy. The Railway project
token must be scoped to the selected project/environment. The signing secret
must be the same environment-owned value published to the Cloud Worker by
`cloud-cf-deploy.yml`.

The workflow mints a replacement reusable `tag:eliza-proxy` Headscale preauth
key over SSH, sends both sensitive Railway values through CLI stdin, creates or
verifies the `/var/lib/tunnel-proxy` volume, uploads this directory, and
converges the exact apex and wildcard Railway custom domains. It expires prior
matching reusable keys only after the canonical `/health` endpoint returns
`{"status":"pass"}` and an arbitrary unsigned wildcard hostname returns 404.

Railway domain attachment and Cloudflare DNS are separate credential
boundaries. The workflow can attach the exact custom domains but never receives
a Cloudflare token. When Railway reports an unverified domain, copy its exact
CNAME/TXT requirements into the protected
`RAILWAY_TUNNEL_DNS_RECORDS_JSON` inventory, add any existing Cloudflare ids to
`DNS_RECORD_IMPORT_IDS_JSON` under `railway-tunnel/<logical-key>`, and dispatch
the protected `Infrastructure` workflow for `pages-domains`. Rerun this deploy
only after the reviewed Terraform plan is applied. The Terraform records stay
DNS-only so Railway terminates wildcard TLS without a paid Cloudflare advanced
certificate.
