FROM docker.io/oven/bun@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2 AS bun
FROM docker.io/library/node@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# Reproduce the exact bunx symlink in the pinned official Bun image.
RUN test ! -e /usr/local/bin/bunx && test ! -L /usr/local/bin/bunx && ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /workspace
