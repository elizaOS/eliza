# syntax=docker/dockerfile:1

FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/tunnel-proxy .

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
  && mkdir -p /var/lib/tunnel-proxy

COPY --from=build /out/tunnel-proxy /usr/local/bin/tunnel-proxy

EXPOSE 8080
ENV PORT=8080
ENV TSNET_STATE_DIR=/var/lib/tunnel-proxy

ENTRYPOINT ["/usr/local/bin/tunnel-proxy"]
