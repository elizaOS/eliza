# Customer-tunnel coordination server. Pin to a known-stable upstream release
# and bump manually after verifying compatibility with our ACL file and
# preauth-key API surface in `packages/lib/services/headscale-client.ts`.
FROM alpine:3.22

ARG HEADSCALE_VERSION=0.28.0
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata wget \
  && case "${TARGETARCH:-amd64}" in \
    amd64) HEADSCALE_ARCH="amd64" ;; \
    arm64) HEADSCALE_ARCH="arm64" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && wget -O /usr/local/bin/headscale \
    "https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_${HEADSCALE_ARCH}" \
  && chmod +x /usr/local/bin/headscale \
  && mkdir -p /etc/headscale /var/lib/headscale

# Drop our config + ACL alongside the image. Railway mounts a volume at
# /var/lib/headscale for the sqlite db and generated keys.
COPY config.yaml /etc/headscale/config.yaml
COPY acl.hujson /etc/headscale/acl.hujson

EXPOSE 8080

CMD ["headscale", "serve"]
