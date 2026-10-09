package otatrust

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HTTPTransport sends only anonymous GETs. Hosts are provisioned by the native
// supervisor, never accepted from release metadata. Close cancels active I/O.
type HTTPTransport struct {
	hosts               map[string]bool
	client              *http.Client
	ctx                 context.Context
	cancel              context.CancelFunc
	active              chan struct{}
	mu                  sync.Mutex
	retryAt             time.Time
	artifactIdleTimeout time.Duration
	lookup              func(context.Context, string, string) ([]netip.Addr, error)
	dial                func(context.Context, string, string) (net.Conn, error)
}

var hostnamePattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$`)

func newHTTPTransport(approvedHosts string) (*HTTPTransport, error) {
	hosts := map[string]bool{}
	for _, host := range strings.Split(approvedHosts, ",") {
		if !hostnamePattern.MatchString(host) || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".localhost") {
			return nil, errors.New("invalid provisioned HTTPS host")
		}
		hosts[host] = true
	}
	if len(hosts) > 16 {
		return nil, errors.New("host limit exceeded")
	}
	roots, err := platformRoots()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t := &HTTPTransport{artifactIdleTimeout: 45 * time.Second, hosts: hosts, ctx: ctx, cancel: cancel, active: make(chan struct{}, 1), lookup: net.DefaultResolver.LookupNetIP, dial: (&net.Dialer{Timeout: 10 * time.Second}).DialContext}
	transport := &http.Transport{Proxy: nil, DialContext: t.dialPublic, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, DisableCompression: true, ForceAttemptHTTP2: true, MaxResponseHeaderBytes: 32 * 1024, MaxConnsPerHost: 1, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second}
	t.client = &http.Client{Transport: transport, Timeout: 45 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("redirect limit")
		}
		if err := t.checkURL(req.URL); err != nil {
			return err
		}
		req.Header = make(http.Header)
		req.Header.Set("Accept-Encoding", "identity")
		// Range validators contain no credentials and must survive approved CDN redirects.
		for _, key := range []string{"Range", "If-Range"} {
			if value := via[0].Header.Get(key); value != "" {
				req.Header.Set(key, value)
			}
		}
		return nil
	}}
	return t, nil
}
func platformRoots() (*x509.CertPool, error) {
	if runtime.GOOS != "android" {
		return x509.SystemCertPool()
	}
	// Use the shipped system trust store. Do not read environment-selected CA
	// bundles or user-added roots inside the update supervisor.
	directory := "/apex/com.android.conscrypt/cacerts"
	if _, err := os.Stat(directory); os.IsNotExist(err) {
		directory = "/system/etc/security/cacerts"
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, errors.New("Android system trust store unavailable")
	}
	roots := x509.NewCertPool()
	loaded := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, errors.New("Android system certificate unreadable")
		}
		if roots.AppendCertsFromPEM(data) {
			loaded = true
		}
	}
	if !loaded {
		return nil, errors.New("Android system trust store empty")
	}
	return roots, nil
}
func (t *HTTPTransport) checkURL(u *url.URL) error {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || !t.hosts[u.Hostname()] || u.Host != u.Hostname() {
		return errors.New("unapproved HTTPS authority")
	}
	return nil
}

var forbidden = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}

func publicAddress(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range forbidden {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
func (t *HTTPTransport) dialPublic(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || !t.hosts[host] {
		return nil, errors.New("unapproved connection authority")
	}
	ips, err := t.lookup(ctx, "ip", host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, errors.New("public DNS resolution failed")
	}
	for _, ip := range ips {
		if !publicAddress(ip) {
			return nil, errors.New("nonpublic DNS answer rejected")
		}
	}
	// Connect directly to the checked IP. Do not resolve the hostname again.
	for _, ip := range ips {
		conn, err := t.dial(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, errors.New("public endpoint unavailable")
}
func (t *HTTPTransport) Fetch(address string, limit int64) (*Response, error) {
	if t == nil || t.ctx == nil || t.client == nil {
		return nil, errors.New("transport not initialized")
	}
	if limit < 1 || limit > maxBytes {
		return nil, errors.New("metadata response limit invalid")
	}
	u, err := url.Parse(address)
	if err != nil || t.checkURL(u) != nil {
		return nil, errors.New("unapproved HTTPS URL")
	}
	select {
	case <-t.ctx.Done():
		return nil, errors.New("transport closed")
	default:
	}
	select {
	case t.active <- struct{}{}:
		defer func() { <-t.active }()
	default:
		return nil, errors.New("request already active")
	}
	if t.RetryAfterMillis() > 0 {
		return nil, errors.New("server retry delay active")
	}
	req, err := http.NewRequestWithContext(t.ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, errors.New("invalid HTTPS request")
	}
	req.Header.Set("Accept-Encoding", "identity")
	response, err := t.client.Do(req)
	if err != nil {
		return nil, errors.New("HTTPS request failed")
	}
	defer response.Body.Close()
	if response.StatusCode == 429 || response.StatusCode == 503 {
		delay := retryDelay(response.Header.Get("Retry-After"), time.Now())
		t.mu.Lock()
		t.retryAt = time.Now().Add(delay)
		t.mu.Unlock()
	}
	if response.StatusCode != 200 {
		return &Response{Status: response.StatusCode}, nil
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return nil, errors.New("compressed metadata response rejected")
	}
	if response.ContentLength > limit {
		return nil, errors.New("declared response exceeds limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, errors.New("incomplete HTTPS response")
	}
	if int64(len(data)) > limit {
		return nil, errors.New("response exceeds limit")
	}
	if response.ContentLength >= 0 && response.ContentLength != int64(len(data)) {
		return nil, errors.New("response length mismatch")
	}
	return &Response{Status: response.StatusCode, Data: data}, nil
}
func retryDelay(value string, now time.Time) time.Duration {
	delay := time.Minute
	digits := strings.TrimLeft(value, "0")
	if len(digits) > 5 && regexp.MustCompile(`^[0-9]+$`).MatchString(value) {
		return 24 * time.Hour
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		if seconds > 86400 {
			seconds = 86400
		}
		delay = time.Duration(seconds) * time.Second
	} else if date, err := http.ParseTime(value); err == nil {
		delay = date.Sub(now)
	}
	if delay < time.Second {
		return time.Second
	}
	if delay > 24*time.Hour {
		return 24 * time.Hour
	}
	return delay
}

// RetryAfterMillis is a scheduling hint, never a source of TUF trusted time.
func (t *HTTPTransport) RetryAfterMillis() int64 {
	if t == nil || t.ctx == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	remaining := time.Until(t.retryAt).Milliseconds()
	if remaining < 0 {
		return 0
	}
	return remaining
}
func (t *HTTPTransport) Close() {
	if t == nil {
		return
	}
	if t.cancel != nil {
		t.cancel()
	}
	if t.client != nil {
		t.client.CloseIdleConnections()
	}
}
