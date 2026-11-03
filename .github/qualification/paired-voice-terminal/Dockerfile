FROM docker.io/oven/bun@sha256:296a79bbc988bb0a91ef11099af70a78a8cba98b73fd53f7b2a7715b7c86ced2 AS bun
FROM docker.io/library/node@sha256:da81deb96d49fc84c9813bc4f16dfdb1d4d7e3671b74cd54fd944428f1444afe
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace/sdk
