FROM node:24-alpine AS verify

# The contract tests exercise the deployment shell scripts and local git
# executor for real, so the verify stage needs bash, git, jq, and GNU
# coreutils (the deployment scripts use realpath -m).
RUN apk add --no-cache bash git jq coreutils

WORKDIR /repo/services/merge-steward

COPY services/merge-steward/package*.json ./
RUN npm ci

COPY services/merge-steward/db ./db
COPY services/merge-steward/openapi.json ./openapi.json
COPY services/merge-steward/production-evidence.schema.json ./production-evidence.schema.json
COPY services/merge-steward/scripts ./scripts
COPY services/merge-steward/src ./src
COPY services/merge-steward/test ./test
COPY services/merge-steward/README.md ./README.md
COPY services/merge-steward/Dockerfile ./Dockerfile
COPY .forgejo /repo/.forgejo
COPY deployment /repo/deployment
COPY docs /repo/docs
COPY scripts /repo/scripts
COPY README.md /repo/README.md

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
