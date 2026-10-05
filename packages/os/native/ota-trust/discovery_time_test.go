package otatrust

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sourceDiscovery(t *testing.T) (*enrolledFixture, *fixtureTimeSource) {
	t.Helper()
	f := enrolledTest(t)
	source := &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli() + 1000}}
	f.session.session.source = source
	return f, source
}
func runWithSource(f *enrolledFixture) (*DiscoveryResult, error) {
	return f.session.RunWithTimeSource(f.schedule, f.cache, f.admission, f.prepared, f.device, 1, 0)
}

func TestSourceDiscoveryAuthenticatesOverRealTLS(t *testing.T) {
	f := enrolledTest(t)
	f.session.Close()
	// Reprovision a distinct fixture enrollment for the controlled TLS hostname.
	config := f.session.config
	config.MetadataBase = "https://example.com/metadata/"
	config.Hosts = []string{"example.com", "github.com"}
	configJSON, _ := json.Marshal(config)
	directory := enrollmentDirectory(t)
	if err := InitializeEnrollment(directory, configJSON, f.transport.root); err != nil {
		t.Fatal(err)
	}
	enrollment, err := ReadEnrollment(directory)
	if err != nil {
		t.Fatal(err)
	}
	device := mutateAdmission(t, f.device, func(d map[string]any) { d["opaqueCohortId"] = enrollment.CohortID })
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := f.transport.files[baseURL+strings.TrimPrefix(r.URL.Path, "/metadata/")]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Write(data)
	}))
	defer server.Close()
	source := &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli() + 1000}}
	discovery, err := NewEnrolledDiscoveryWithTimeSource(directory, source)
	if err != nil {
		t.Fatal(err)
	}
	defer discovery.Close()
	transport := discovery.session.transport.(*HTTPTransport)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport.client.Transport.(*timeCheckedTransport).base.TLSClientConfig.RootCAs = pool
	transport.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	transport.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			return nil, errors.New("unchecked dial")
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	result, err := discovery.RunWithTimeSource(f.schedule, f.cache, f.admission, f.prepared, device, 1, 0)
	if err != nil || result.Status != "admitted" || !validHex(result.AuthorizationID) || !bytes.Equal(result.Descriptor, f.transport.body) {
		t.Fatalf("%+v %v", result, err)
	}
	if _, err = loadRecovery(f.prepared, f.admission, result.AuthorizationID); err != nil {
		t.Fatal(err)
	}
}

func TestSourceDiscoveryUsesFreshBoundsAfterNetwork(t *testing.T) {
	f, source := sourceDiscovery(t)
	f.transport.body = mutateAdmission(t, f.transport.body, func(d map[string]any) {
		d["rollout"].(map[string]any)["expires"] = now.Add(30 * time.Second).Format("2006-01-02T15:04:05.000Z")
	})
	f.transport.publish(t, 1)
	f.transport.hook = func() { source.set(now.UnixMilli()+1000, now.UnixMilli()+30000, nil) }
	result, err := runWithSource(f)
	if err != nil || result.Status != "deferred" || result.Admission == nil || result.Admission.Reason != "rollout-time" || len(result.Descriptor) != 0 || result.AuthorizationID != "" {
		t.Fatalf("expired admission exposed: %+v %v", result, err)
	}
}

func TestSourceDiscoveryLossRetainsClaimAndExposesNoAuthorization(t *testing.T) {
	f, source := sourceDiscovery(t)
	f.transport.hook = func() { source.set(1, 1, errors.New("qualified clock lost")) }
	if result, err := runWithSource(f); err == nil || result != nil {
		t.Fatalf("clock loss accepted: %+v %v", result, err)
	}
	state, err := readDiscovery(f.schedule)
	if err != nil || state.Lease == "" {
		t.Fatalf("claim vanished: %+v %v", state, err)
	}
	entries, err := os.ReadDir(f.prepared)
	if err != nil || len(entries) != 0 {
		t.Fatalf("authorization exposed: %v %v", entries, err)
	}
	// With qualified time restored after lease expiry, existing crash recovery
	// converts the abandoned attempt into durable backoff without a reset.
	if _, err = BeginDiscoveryInterval(f.schedule, state.LeaseUntil, state.LeaseUntil, 0); err != nil {
		t.Fatal(err)
	}
	state, err = readDiscovery(f.schedule)
	if err != nil || state.Failures != 1 {
		t.Fatalf("abandoned attempt not counted: %+v %v", state, err)
	}
}

func TestSourceDiscoveryRejectsMissingSource(t *testing.T) {
	f, source := sourceDiscovery(t)
	source.set(1, 1, errors.New("no anchor"))
	if result, err := runWithSource(f); err == nil || result != nil {
		t.Fatal("unqualified source accepted")
	}
	if _, err := os.Stat(filepath.Join(f.schedule, "schedule.json")); !os.IsNotExist(err) {
		t.Fatal("missing source mutated schedule")
	}
	missing := enrolledTest(t)
	missing.session.session.source = nil
	if _, err := runWithSource(missing); err == nil {
		t.Fatal("source-free instance silently used wall time")
	}
}
