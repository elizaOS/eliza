FROM node:24-alpine AS verify

WORKDIR /repo/services/merge-steward

COPY services/merge-steward/package*.json ./
RUN npm ci

COPY services/merge-steward/db ./db
COPY services/merge-steward/openapi.json ./openapi.json
COPY services/merge-steward/production-evidence.schema.json ./production-evidence.schema.json
COPY services/merge-steward/scripts ./scripts
COPY services/merge-steward/src ./src
COPY services/merge-steward/test ./test
COPY .forgejo /repo/.forgejo
COPY deployment /repo/deployment

RUN npm run check && npm test

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8787

WORKDIR /app

RUN apk add --no-cache git openssh-client

COPY --from=verify --chown=node:node /repo/services/merge-steward/package*.json ./
COPY --from=verify --chown=node:node /repo/services/merge-steward/node_modules ./node_modules
COPY --from=verify --chown=node:node /repo/services/merge-steward/db ./db
COPY --from=verify --chown=node:node /repo/services/merge-steward/openapi.json ./openapi.json
COPY --from=verify --chown=node:node /repo/services/merge-steward/production-evidence.schema.json ./production-evidence.schema.json
COPY --from=verify --chown=node:node /repo/services/merge-steward/src ./src

USER node

EXPOSE 8787

CMD ["npm", "start"]
