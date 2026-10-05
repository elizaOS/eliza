# Tunnel proxy

Go HTTP proxy for signed, tenant-scoped Eliza Cloud tunnel URLs over Headscale.
Keep hostname signatures, expiry checks, and tailnet isolation enforced.

Configure `HEADSCALE_PUBLIC_URL`, `TUNNEL_PROXY_TS_AUTHKEY`, `TUNNEL_PROXY_HOST`,
`TUNNEL_TAILNET_DOMAIN`, and `TUNNEL_HOSTNAME_SIGNING_SECRET` for the deployment.
Use the Go version in `go.mod`. Build and test from this directory:

```bash
go build ./...
go test ./...
```

The Dockerfile and `railway.toml` define the deployed service.
