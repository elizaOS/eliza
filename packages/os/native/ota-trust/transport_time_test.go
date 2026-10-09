package otatrust

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureTimeSource struct {
	mu     sync.Mutex
	bounds TrustedTimeInterval
	err    error
}

func (s *fixtureTimeSource) ReadTime() (*TrustedTimeInterval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := s.bounds
	return &copy, s.err
}
func (s *fixtureTimeSource) set(lower, upper int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bounds = TrustedTimeInterval{lower, upper}
	s.err = err
}

// A certificate valid only in 2050 proves that validation uses the supplied
// fixture clock rather than today's wall clock. Roots/DNS/dial overrides exist
// only in this test; production uses platform roots and validated public DNS.
func futureHTTPS(t *testing.T, handler http.HandlerFunc) (*HTTPTransport, *fixtureTimeSource, *x509.Certificate) {
	t.Helper()
	start := time.Date(2050, 1, 1, 0, 0, 0, 0, time.UTC)
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: start, NotAfter: start.Add(24 * time.Hour), DNSNames: []string{"example.com"}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	server.StartTLS()
	t.Cleanup(server.Close)
	source := &fixtureTimeSource{bounds: TrustedTimeInterval{start.Add(time.Hour).UnixMilli(), start.Add(2 * time.Hour).UnixMilli()}}
	transport, err := NewHTTPTransportWithTimeSource("example.com,unrelated.test", source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(transport.Close)
	base := transport.client.Transport.(*timeCheckedTransport).base
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	base.TLSClientConfig.RootCAs = pool
	transport.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	transport.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			return nil, errors.New("unchecked address")
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	return transport, source, cert
}

func TestIntervalTLSUsesAuthenticatedTimeAndKeepsChainChecks(t *testing.T) {
	transport, _, _ := futureHTTPS(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") })
	if response, err := transport.Fetch("https://example.com/", 16); err != nil || string(response.Data) != "ok" {
		t.Fatalf("qualified future time failed: %v", err)
	}
	if _, err := transport.Fetch("https://unrelated.test/", 16); err == nil {
		t.Fatal("hostname verification disabled")
	}
	base := transport.client.Transport.(*timeCheckedTransport).base
	if base.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
	base.CloseIdleConnections()
	base.TLSClientConfig.RootCAs = x509.NewCertPool()
	if _, err := transport.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
}

func TestIntervalTLSBoundariesAndSourceLoss(t *testing.T) {
	for _, name := range []string{"before", "straddle-start", "exact-start", "before-expiry", "exact-expiry", "straddle-expiry", "after", "reversed", "missing"} {
		t.Run(name, func(t *testing.T) {
			transport, source, cert := futureHTTPS(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") })
			start, end := cert.NotBefore.UnixMilli(), cert.NotAfter.UnixMilli()
			var lower, upper int64
			accept := false
			var failure error
			switch name {
			case "before":
				lower, upper = start-2, start-1
			case "straddle-start":
				lower, upper = start-1, start+1
			case "exact-start":
				lower, upper = start, start
				accept = true
			case "before-expiry":
				lower, upper = end-1, end-1
				accept = true
			case "exact-expiry":
				lower, upper = end, end
			case "straddle-expiry":
				lower, upper = end-1, end+1
			case "after":
				lower, upper = end+1, end+2
			case "reversed":
				lower, upper = start+1, start
			case "missing":
				lower, upper = start, start
				failure = errors.New("clock lost")
			}
			source.set(lower, upper, failure)
			response, err := transport.Fetch("https://example.com/", 16)
			if accept {
				if err != nil || response == nil {
					t.Fatal(err)
				}
			} else if err == nil || response != nil {
				t.Fatal("invalid time accepted")
			}
		})
	}
}

func TestIntervalTLSRechecksReusedConnectionAndResponse(t *testing.T) {
	var requests atomic.Int32
	var mutate func()
	transport, source, cert := futureHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/expire" {
			mutate()
		}
		fmt.Fprint(w, "ok")
	})
	mutate = func() { source.set(cert.NotAfter.UnixMilli(), cert.NotAfter.UnixMilli(), nil) }
	if _, err := transport.Fetch("https://example.com/", 16); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.Fetch("https://example.com/expire", 16); err == nil {
		t.Fatal("expired response on reused session accepted")
	}
	source.set(1, 1, errors.New("source unavailable"))
	before := requests.Load()
	if _, err := transport.Fetch("https://example.com/", 16); err == nil {
		t.Fatal("missing source accepted")
	}
	if requests.Load() != before {
		t.Fatal("unavailable clock issued request")
	}
}

func TestIntervalTLSEveryCertificateMustCoverBounds(t *testing.T) {
	source := &fixtureTimeSource{bounds: TrustedTimeInterval{1000, 2000}}
	valid := &x509.Certificate{NotBefore: time.UnixMilli(999), NotAfter: time.UnixMilli(2001)}
	late := &x509.Certificate{NotBefore: time.UnixMilli(1500), NotAfter: time.UnixMilli(2001)}
	for _, chain := range [][]*x509.Certificate{{valid, late}, {late, valid}, {valid, nil}, {}} {
		if err := verifyTimeInterval(source, &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{chain}}); err == nil {
			t.Fatal("invalid intermediate/root interval accepted")
		}
	}
	if err := verifyTimeInterval(source, &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{late}, {valid}}}); err != nil {
		t.Fatal("valid alternate chain rejected", err)
	}
	if err := verifyTimeInterval(source, nil); err == nil {
		t.Fatal("missing TLS state accepted")
	}
}

func TestIntervalArtifactTransferKeepsAuthenticatedTLS(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	transport, _, _ := futureHTTPS(t, func(w http.ResponseWriter, r *http.Request) { w.Write(body) })
	downloader := artifactDownloaderWithTransport(transport)
	if _, err := downloader.Download(dir, "https://example.com/agent.apk", digest, int64(len(body)), 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := NewHTTPTransportWithTimeSource("example.com", nil); err == nil {
		t.Fatal("missing source configured")
	}
	if _, err := NewArtifactDownloaderWithTimeSource("example.com", nil); err == nil {
		t.Fatal("missing artifact source configured")
	}
}
