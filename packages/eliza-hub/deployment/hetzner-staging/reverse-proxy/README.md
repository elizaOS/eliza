# Reverse Proxy

The Compose stack binds Forgejo and Merge Steward to loopback. Terminate TLS on
the host and proxy only reviewed routes into those loopback ports.

The Caddy example serves:

- Forgejo at `https://git.staging.example.invalid/`
- Merge Steward at `https://git.staging.example.invalid/steward/`

The `/steward/*` route strips the `/steward` prefix before proxying to the
Node service on `127.0.0.1:8080`. Use that public base path for Eliza Cloud
clients and deployment checks:

```bash
MERGE_STEWARD_URL=https://git.staging.example.invalid/steward
MERGE_STEWARD_DOCTOR_TOKEN="$MERGE_STEWARD_API_TOKEN" \
npm run doctor --prefix services/merge-steward -- "$MERGE_STEWARD_URL"
```

SSH is not handled by Caddy. Keep `FORGEJO_SSH_BIND=127.0.0.1` until the host
firewall, public SSH port, and Forgejo SSH domain are explicitly reviewed.
