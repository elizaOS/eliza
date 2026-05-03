# Steward – Docker image (API + Proxy)
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY package.json bun.lock* bunfig.toml* turbo.json tsconfig.json ./
COPY packages/ packages/

# Remove packages not needed for API/proxy to avoid resolution errors.
# sdk is excluded by .dockerignore but other packages reference it,
# so we create a stub package.json for it.
RUN bun -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(Array.isArray(p.workspaces))p.workspaces=p.workspaces.filter(w=>w!=='web'&&!String(w).startsWith('packages/examples'));fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" && \
    rm -rf packages/examples packages/agent-trader packages/react packages/eliza-plugin packages/seed && \
    if [ ! -d packages/sdk ]; then \
      mkdir -p packages/sdk && \
      printf '{"name":"@stwd/sdk","version":"0.0.0","private":true}\n' > packages/sdk/package.json; \
    fi

RUN bun install --no-frozen-lockfile
RUN bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=builder /app/package.json /app/bun.lock* /app/bunfig.toml* /app/turbo.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/node_modules/ node_modules/

ENV PORT=3200 NODE_ENV=production
EXPOSE 3200 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:'+(process.env.STEWARD_PROXY_PORT||process.env.PORT||'3200')+'/health');process.exit(r.ok?0:1)" || exit 1

CMD ["bun", "run", "packages/api/src/index.ts"]
