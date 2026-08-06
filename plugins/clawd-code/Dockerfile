FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CLAWD_API_HOST=0.0.0.0
ENV CLAWD_API_PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY spinners ./spinners
COPY clawd-plugin ./clawd-plugin
COPY docs ./docs
COPY .env.example README.md CLAWD.md Skill.md agent.md LICENSE clawd.json ./
EXPOSE 3001
CMD ["npm", "run", "api"]
