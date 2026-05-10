package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

const (
	defaultControlURL    = "https://headscale.elizacloud.ai"
	defaultPublicHost    = "tunnel.elizacloud.ai"
	defaultTailnetDomain = "tunnel.eliza.local"
	defaultStateDir      = "/var/lib/tunnel-proxy"
	defaultHostname      = "eliza-tunnel-proxy"
	defaultPort          = "8080"
	proxyTag             = "tag:eliza-proxy"
)

var hostLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

type config struct {
	authKey       string
	controlURL    string
	publicHost    string
	tailnetDomain string
	stateDir      string
	hostname      string
	port          string
}

type targetHostContextKey struct{}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("invalid config: %v", err)
	}
	if err := os.MkdirAll(cfg.stateDir, 0o700); err != nil {
		log.Fatalf("create tsnet state dir: %v", err)
	}

	ts := &tsnet.Server{
		Dir:           cfg.stateDir,
		Hostname:      cfg.hostname,
		AuthKey:       cfg.authKey,
		ControlURL:    cfg.controlURL,
		AdvertiseTags: []string{proxyTag},
		Ephemeral:     false,
		UserLogf:      log.Printf,
	}
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	status, err := ts.Up(ctx)
	if err != nil {
		log.Fatalf("join headscale tailnet: %v", err)
	}
	log.Printf("joined headscale tailnet as %s with ips=%v", cfg.hostname, status.TailscaleIPs)

	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return ts.Dial(ctx, network, address)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		TLSClientConfig: &tls.Config{
			// The upstream is a customer-owned tailscale serve endpoint inside
			// the private tailnet. Headscale MagicDNS, ACLs, and WireGuard peer
			// identity provide the trust boundary here; public TLS terminates at
			// Railway before this proxy.
			InsecureSkipVerify: true,
		},
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			targetHost, _ := pr.In.Context().Value(targetHostContextKey{}).(string)
			pr.SetURL(&url.URL{Scheme: "https", Host: targetHost})
			pr.Out.Host = targetHost
			pr.Out.Header.Set("X-Forwarded-Host", pr.In.Host)
			pr.Out.Header.Set("X-Forwarded-Proto", forwardedProto(pr.In))
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("proxy error host=%q path=%q err=%v", r.Host, r.URL.Path, err)
			http.Error(w, "tunnel target unavailable", http.StatusBadGateway)
		},
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || r.URL.Path == "/ready" {
			writeJSON(w, http.StatusOK, map[string]string{"status": "pass"})
			return
		}

		targetHost, ok := targetHostForRequest(r.Host, cfg.publicHost, cfg.tailnetDomain)
		if !ok {
			http.NotFound(w, r)
			return
		}

		ctx := context.WithValue(r.Context(), targetHostContextKey{}, targetHost)
		proxy.ServeHTTP(w, r.WithContext(ctx))
	})

	server := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           logRequests(handler),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf(
		"listening on :%s for *.%s -> *.%s",
		cfg.port,
		cfg.publicHost,
		cfg.tailnetDomain,
	)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func loadConfig() (config, error) {
	cfg := config{
		authKey:       strings.TrimSpace(os.Getenv("TUNNEL_PROXY_TS_AUTHKEY")),
		controlURL:    firstEnv("HEADSCALE_PUBLIC_URL", "TS_CONTROL_URL", defaultControlURL),
		publicHost:    firstEnv("TUNNEL_PROXY_HOST", "", defaultPublicHost),
		tailnetDomain: firstEnv("TUNNEL_TAILNET_DOMAIN", "", defaultTailnetDomain),
		stateDir:      firstEnv("TSNET_STATE_DIR", "", defaultStateDir),
		hostname:      firstEnv("TUNNEL_PROXY_HOSTNAME", "", defaultHostname),
		port:          firstEnv("PORT", "", defaultPort),
	}
	cfg.controlURL = strings.TrimRight(cfg.controlURL, "/")
	cfg.publicHost = normalizeHost(cfg.publicHost)
	cfg.tailnetDomain = normalizeHost(cfg.tailnetDomain)
	cfg.hostname = normalizeHost(cfg.hostname)

	if cfg.authKey == "" {
		return cfg, errors.New("TUNNEL_PROXY_TS_AUTHKEY is required")
	}
	if cfg.controlURL == "" || !strings.HasPrefix(cfg.controlURL, "https://") {
		return cfg, fmt.Errorf("HEADSCALE_PUBLIC_URL/TS_CONTROL_URL must be an https URL")
	}
	if cfg.publicHost == "" {
		return cfg, errors.New("TUNNEL_PROXY_HOST is required")
	}
	if cfg.tailnetDomain == "" {
		return cfg, errors.New("TUNNEL_TAILNET_DOMAIN is required")
	}
	if cfg.port == "" {
		return cfg, errors.New("PORT is required")
	}
	return cfg, nil
}

func firstEnv(primary string, legacy string, fallback string) string {
	if primary != "" {
		if value := strings.TrimSpace(os.Getenv(primary)); value != "" {
			return value
		}
	}
	if legacy != "" {
		if value := strings.TrimSpace(os.Getenv(legacy)); value != "" {
			return value
		}
	}
	return fallback
}

func targetHostForRequest(hostHeader string, publicHost string, tailnetDomain string) (string, bool) {
	host := normalizeHost(hostHeader)
	if host == "" || host == publicHost {
		return "", false
	}

	suffix := "." + publicHost
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}

	label := strings.TrimSuffix(host, suffix)
	if !hostLabelPattern.MatchString(label) {
		return "", false
	}
	return label + "." + tailnetDomain, true
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	if withoutPort, _, err := net.SplitHostPort(host); err == nil {
		host = withoutPort
	}
	return strings.TrimSuffix(host, ".")
}

func forwardedProto(r *http.Request) string {
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/health+json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write json response: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("request method=%s host=%q path=%q duration=%s", r.Method, r.Host, r.URL.Path, time.Since(start))
	})
}
