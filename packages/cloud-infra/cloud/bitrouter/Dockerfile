FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl expect xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g bitrouter

WORKDIR /app
COPY bitrouter.yaml /app/bitrouter.yaml
COPY auth-proxy.mjs /app/auth-proxy.mjs
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV BITROUTER_HOME=/app
ENV BITROUTER_UPSTREAM=http://127.0.0.1:4356
ENV BITROUTER_DATABASE_URL=sqlite:/data/bitrouter.db
ENV BITROUTER_INTERNAL_JWT_FILE=/data/internal.jwt

CMD ["/app/entrypoint.sh"]
