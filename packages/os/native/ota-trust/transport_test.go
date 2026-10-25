package otatrust

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func localHTTPS(t *testing.T, handler http.HandlerFunc) (*HTTPTransport, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	transport, err := newHTTPTransport("example.com,unrelated.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(transport.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport.client.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
	transport.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	transport.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			return nil, fmt.Errorf("unchecked dial: %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	return transport, server
}
func TestHTTPSMetadataAndLimits(t *testing.T) {
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Accept-Encoding") != "identity" {
			t.Error("ambient credentials/compression")
		}
		switch r.URL.Path {
		case "/ok":
			fmt.Fprint(w, `{"ok":true}`)
		case "/big":
			w.Header().Set("Content-Length", "9000")
			fmt.Fprint(w, "too big")
		case "/overflow":
			w.(http.Flusher).Flush()
			fmt.Fprint(w, strings.Repeat("a", 100))
		case "/short":
			w.Header().Set("Content-Length", "100")
			fmt.Fprint(w, "short")
		case "/compressed":
			w.Header().Set("Content-Encoding", "gzip")
			fmt.Fprint(w, "compressed")
		case "/loop":
			http.Redirect(w, r, "https://example.com/loop", 302)
		case "/downgrade":
			http.Redirect(w, r, "http://example.com/ok", 302)
		case "/foreign":
			http.Redirect(w, r, "https://unapproved.example/ok", 302)
		case "/cookie":
			w.Header().Set("Set-Cookie", "secret=value")
			http.Redirect(w, r, "https://example.com/ok", 302)
		default:
			w.WriteHeader(404)
		}
	})
	for _, route := range []string{"ok", "cookie"} {
		response, err := transport.Fetch("https://example.com/"+route, 1024)
		if err != nil || string(response.Data) != `{"ok":true}` {
			t.Fatalf("%s: %v %v", route, response, err)
		}
	}
	for _, route := range []string{"big", "overflow", "short", "compressed", "loop", "downgrade", "foreign"} {
		if _, err := transport.Fetch("https://example.com/"+route, 16); err == nil {
			t.Fatalf("%s accepted", route)
		}
	}
	response, err := transport.Fetch("https://example.com/missing", 16)
	if err != nil || response.Status != 404 || len(response.Data) != 0 {
		t.Fatal("404 not preserved")
	}
}
func TestTLSCertificateAndHostnameValidation(t *testing.T) {
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") })
	if _, err := transport.Fetch("https://unrelated.test/", 16); err == nil {
		t.Fatal("wrong certificate hostname accepted")
	}
	transport.client.Transport.(*http.Transport).TLSClientConfig.RootCAs = x509.NewCertPool()
	if _, err := transport.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("unknown certificate authority accepted")
	}
}
func TestDNSAnswersAreValidatedBeforeDirectDial(t *testing.T) {
	transport, err := newHTTPTransport("example.com")
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	dialed := false
	transport.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}
	transport.dial = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("unexpected")
	}
	if _, err = transport.dialPublic(context.Background(), "tcp", "example.com:443"); err == nil || dialed {
		t.Fatal("mixed public/private DNS was dialed")
	}
	transport.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	transport.dial = func(_ context.Context, _ string, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			t.Fatalf("DNS repeated: %s", address)
		}
		dialed = true
		return nil, errors.New("fixture")
	}
	transport.dialPublic(context.Background(), "tcp", "example.com:443")
	if !dialed {
		t.Fatal("public address not dialed")
	}
}
func TestPublicAddressClassification(t *testing.T) {
	for _, value := range []string{"0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "64:ff9b::7f00:1", "3fff::1", "fe80::1%en0"} {
		if publicAddress(netip.MustParseAddr(value)) {
			t.Errorf("nonpublic address accepted: %s", value)
		}
	}
	for _, value := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if !publicAddress(netip.MustParseAddr(value)) {
			t.Errorf("public address rejected: %s", value)
		}
	}
}
func TestRetryAfterAndCancellation(t *testing.T) {
	var count atomic.Int32
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(429)
	})
	response, err := transport.Fetch("https://example.com/", 16)
	if err != nil || response.Status != 429 || transport.RetryAfterMillis() < 119000 {
		t.Fatal("retry-after not honored")
	}
	if _, err = transport.Fetch("https://example.com/", 16); err == nil || count.Load() != 1 {
		t.Fatal("throttled server contacted again")
	}
	started := make(chan struct{})
	slow, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() })
	done := make(chan error, 1)
	go func() { _, err := slow.Fetch("https://example.com/", 16); done <- err }()
	<-started
	if _, err = slow.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("concurrent request admitted")
	}
	slow.Close()
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("cancelled request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt request")
	}
	if _, err = slow.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("closed transport reused")
	}
}
func TestRetryHintBoundsAndURLPolicy(t *testing.T) {
	now := time.Now()
	for value, want := range map[string]time.Duration{"-1": time.Minute, "nonsense": time.Minute, "0": time.Second, "999999999": 24 * time.Hour, "999999999999999999999999999": 24 * time.Hour} {
		if got := retryDelay(value, now); got != want {
			t.Fatalf("retry %s=%v", value, got)
		}
	}
	transport, err := newHTTPTransport("example.com")
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	for _, address := range []string{"http://example.com/", "https://user:pass@example.com/", "https://example.com:443/", "https://example.com/#secret", "https://127.0.0.1/", "https://example.com.evil.test/"} {
		if _, err = transport.Fetch(address, 16); err == nil {
			t.Fatal("unsafe URL admitted")
		}
	}
}

func TestUninitializedBindingFailsClosed(t *testing.T) {
	transport := &HTTPTransport{}
	transport.Close()
	if transport.RetryAfterMillis() != 0 {
		t.Fatal("unexpected delay")
	}
	if _, err := transport.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("uninitialized transport accepted")
	}
}

func TestTransportHasWholeSessionDeadline(t *testing.T) {
	transport, err := newHTTPTransport("example.com")
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	deadline, ok := transport.ctx.Deadline()
	if !ok || time.Until(deadline) > 2*time.Minute || time.Until(deadline) < 119*time.Second {
		t.Fatal("missing bounded check deadline")
	}
}
func TestRequestDeadlineInterruptsSlowBody(t *testing.T) {
	release := make(chan struct{})
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, _ *http.Request) {
		w.(http.Flusher).Flush()
		// Keep the body open until cleanup. Returning on request cancellation
		// can send a clean EOF that races the client's timeout assertion.
		<-release
	})
	t.Cleanup(func() { close(release) })
	transport.client.Timeout = 50 * time.Millisecond
	started := time.Now()
	if _, err := transport.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("stalled body accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("body deadline ignored")
	}
}
