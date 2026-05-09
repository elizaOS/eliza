# Customer-tunnel coordination server. Pin to a known-stable upstream tag —
# bump this tag manually after verifying compatibility with our ACL file
# and preauth-key API surface in `packages/lib/services/headscale-client.ts`.
FROM headscale/headscale:0.26-stable

# Drop our config + ACL alongside the image. Railway mounts a volume at
# /var/lib/headscale for the sqlite db; everything else is read-only.
COPY config.yaml /etc/headscale/config.yaml
COPY acl.hujson /etc/headscale/acl.hujson

EXPOSE 8080

CMD ["headscale", "serve"]
