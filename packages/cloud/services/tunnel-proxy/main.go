package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const (
	defaultControlURL    = "https://headscale.eliza.app"
	defaultPublicHost    = "tunnel.eliza.app"
	defaultTailnetDomain = "tunnel.eliza.local"
	defaultStateDir      = "/var/lib/tunnel-proxy"
	defaultHostname      = "eliza-tunnel-proxy"
	defaultPort          = "8080"
)

var (
	unsignedTunnelHostPattern = regexp.MustCompile(`^eliza-[a-z0-9]{1,12}-[a-f0-9]{12,32}$`)
	signedTunnelHostPattern   = regexp.MustCompile(`^eliza-[a-z0-9]{1,10}-[a-f0-9]{20}-[a-z0-9]{6,10}-[a-f0-9]{16}$`)
)

type config struct {
	authKey       string
	controlURL    string
	publicHost    string
	publicAliases []string
	tailnetDomain string
	stateDir      string
	hostname      string
	port          string
	signingSecret string
	allowUnsigned bool
	stateURL      string
	stateToken    string
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
		Dir:        cfg.stateDir,
		Hostname:   cfg.hostname,
		AuthKey:    cfg.authKey,
		ControlURL: cfg.controlURL,
		Ephemeral:  false,
		UserLogf:   log.Printf,
	}
	if cfg.stateURL != "" {
		durable, err := newRemoteStateStore(cfg.stateURL, cfg.stateToken)
		if err != nil {
			log.Fatalf("configure tsnet state: %v", err)
		}
		ts.Store = durable
	}
	defer ts.Close()

	shutdown, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithTimeout(shutdown, 2*time.Minute)
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
			// the hosting edge before this proxy.
			InsecureSkipVerify: true,
		},
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			targetHost, _ := pr.In.Context().Value(targetHostContextKey{}).(string)
			pr.SetURL(&url.URL{Scheme: "https", Host: targetHost})
			pr.Out.Host = targetHost
			pr.Out.Header.Set("X-Forwarded-Host", forwardedHost(pr.In))
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

		targetHost, ok := cfg.targetForRequest(r.Host)
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
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-shutdown.Done()
		drain, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(drain); err != nil {
			log.Printf("shutdown HTTP server: %v", err)
		}
	}()
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
	<-drained
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
		signingSecret: strings.TrimSpace(os.Getenv("TUNNEL_HOSTNAME_SIGNING_SECRET")),
		allowUnsigned: readBoolEnv("TUNNEL_ALLOW_UNSIGNED_HOSTNAMES"),
		stateURL:      strings.TrimSpace(os.Getenv("TSNET_STATE_URL")),
		stateToken:    strings.TrimSpace(os.Getenv("TSNET_STATE_TOKEN")),
	}
	cfg.controlURL = strings.TrimRight(cfg.controlURL, "/")
	cfg.publicHost = normalizeHost(cfg.publicHost)
	cfg.tailnetDomain = normalizeHost(cfg.tailnetDomain)
	cfg.hostname = normalizeHost(cfg.hostname)
	aliases, err := parsePublicAliases(os.Getenv("TUNNEL_PROXY_HOST_ALIASES"))
	if err != nil {
		return cfg, err
	}
	cfg.publicAliases = aliases

	if cfg.stateURL != "" || cfg.stateToken != "" {
		if _, err := newRemoteStateStore(cfg.stateURL, cfg.stateToken); err != nil {
			return cfg, err
		}
	}
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
	if cfg.signingSecret == "" && !cfg.allowUnsigned {
		return cfg, errors.New("TUNNEL_HOSTNAME_SIGNING_SECRET is required unless TUNNEL_ALLOW_UNSIGNED_HOSTNAMES=true")
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

// Aliases preserve previously issued URLs during a public-domain migration.
// Each hostname still passes the same label signature and expiry checks.
func parsePublicAliases(raw string) ([]string, error) {
	var aliases []string
	if strings.TrimSpace(raw) == "" {
		return aliases, nil
	}
	for _, entry := range strings.Split(raw, ",") {
		host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(entry)), ".")
		if len(host) == 0 || len(host) > 253 || !strings.Contains(host, ".") {
			return nil, errors.New("TUNNEL_PROXY_HOST_ALIASES must contain comma-separated DNS hostnames")
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, errors.New("invalid DNS label in TUNNEL_PROXY_HOST_ALIASES")
			}
			for _, ch := range label {
				if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
					return nil, errors.New("invalid DNS character in TUNNEL_PROXY_HOST_ALIASES")
				}
			}
		}
		aliases = append(aliases, host)
	}
	return aliases, nil
}

func (cfg config) targetForRequest(host string) (string, bool) {
	for _, publicHost := range append([]string{cfg.publicHost}, cfg.publicAliases...) {
		if target, ok := targetHostForRequest(host, publicHost, cfg.tailnetDomain, cfg.signingSecret, cfg.allowUnsigned); ok {
			return target, true
		}
	}
	return "", false
}

func targetHostForRequest(
	hostHeader string,
	publicHost string,
	tailnetDomain string,
	signingSecret string,
	allowUnsigned bool,
) (string, bool) {
	host := normalizeHost(hostHeader)
	if host == "" || host == publicHost {
		return "", false
	}

	suffix := "." + publicHost
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}

	label := strings.TrimSuffix(host, suffix)
	if !validTunnelHostLabel(label, signingSecret, allowUnsigned, time.Now()) {
		return "", false
	}
	return label + "." + tailnetDomain, true
}

func validTunnelHostLabel(
	label string,
	signingSecret string,
	allowUnsigned bool,
	now time.Time,
) bool {
	if signingSecret == "" {
		return allowUnsigned && unsignedTunnelHostPattern.MatchString(label)
	}
	if !signedTunnelHostPattern.MatchString(label) {
		return false
	}

	parts := strings.Split(label, "-")
	if len(parts) != 5 {
		return false
	}
	expiresAt, err := strconv.ParseInt(parts[3], 36, 64)
	if err != nil || now.Unix() > expiresAt {
		return false
	}
	payload := strings.Join(parts[:4], "-")
	signature := parts[4]
	expected := tunnelHostSignature(payload, signingSecret)
	return hmac.Equal([]byte(signature), []byte(expected))
}

func tunnelHostSignature(payload string, signingSecret string) string {
	mac := hmac.New(sha256.New, []byte(signingSecret))
	_, _ = mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	if withoutPort, _, err := net.SplitHostPort(host); err == nil {
		host = withoutPort
	}
	return strings.TrimSuffix(host, ".")
}

// forwardedHost preserves the original public agent host supplied by the
// trusted Cloudflare worker. Overwriting it with the tunnel origin host breaks
// origin-bound pairing tokens after the second proxy hop.
func forwardedHost(r *http.Request) string {
	if host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); host != "" {
		return host
	}
	return r.Host
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

func readBoolEnv(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
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
