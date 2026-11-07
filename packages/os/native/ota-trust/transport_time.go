package otatrust

import (
	"crypto/tls"
	"errors"
	"net/http"
	"time"
)

// TrustedTimeInterval is a current authenticated UTC interval, in milliseconds.
// The native source owns authentication, boot identity, suspend-inclusive
// projection, uncertainty growth and freshness. This transport establishes none
// of those guarantees. Sources must be thread-safe, bounded and nonblocking.
type TrustedTimeInterval struct {
	LowerMillis int64
	UpperMillis int64
}

type TrustedTimeSource interface {
	ReadTime() (*TrustedTimeInterval, error)
}

func readTimeBounds(source TrustedTimeSource) (*TrustedTimeInterval, error) {
	if source == nil {
		return nil, errors.New("trusted time source unavailable")
	}
	bounds, err := source.ReadTime()
	if err != nil || bounds == nil || !bounded(bounds.LowerMillis, 1, safeInteger) || !bounded(bounds.UpperMillis, bounds.LowerMillis, safeInteger) {
		return nil, errors.New("trusted time unavailable or invalid")
	}
	// Copy provider-owned storage before using either value beyond this call.
	return &TrustedTimeInterval{LowerMillis: bounds.LowerMillis, UpperMillis: bounds.UpperMillis}, nil
}

// NewHTTPTransportWithTimeSource retains ordinary chain/hostname verification
// and system roots. It replaces only certificate time and adds interval checks.
// It never disables TLS verification and never falls back to wall time when the
// supplied authority fails. This is not a bootstrap time acquisition protocol.
func NewHTTPTransportWithTimeSource(approvedHosts string, source TrustedTimeSource) (*HTTPTransport, error) {
	if _, err := readTimeBounds(source); err != nil {
		return nil, err
	}
	t, err := newHTTPTransport(approvedHosts)
	if err != nil {
		return nil, err
	}
	base := t.client.Transport.(*http.Transport)
	configureIntervalTLS(base.TLSClientConfig, source)
	t.client.Transport = &timeCheckedTransport{base: base, source: source}
	return t, nil
}

func configureIntervalTLS(config *tls.Config, source TrustedTimeSource) {
	config.Time = func() time.Time {
		bounds, err := readTimeBounds(source)
		if err != nil {
			// tls.Config.Time cannot return an error. An invalid early reference
			// normally rejects the chain; VerifyConnection always rejects an
			// unavailable source even if an unusual chain covers this instant.
			return time.Unix(0, 0)
		}
		return time.UnixMilli(bounds.UpperMillis)
	}
	config.VerifyConnection = func(state tls.ConnectionState) error {
		return verifyTimeInterval(source, &state)
	}
}

func verifyTimeInterval(source TrustedTimeSource, state *tls.ConnectionState) error {
	bounds, err := readTimeBounds(source)
	if err != nil {
		return err
	}
	if state == nil || len(state.VerifiedChains) == 0 {
		return errors.New("verified TLS chain unavailable")
	}
	lower, upper := time.UnixMilli(bounds.LowerMillis), time.UnixMilli(bounds.UpperMillis)
	for _, chain := range state.VerifiedChains {
		valid := len(chain) > 0
		for _, cert := range chain {
			if cert == nil || lower.Before(cert.NotBefore) || !upper.Before(cert.NotAfter) {
				valid = false
				break
			}
		}
		if valid {
			return nil
		}
	}
	return errors.New("TLS chain does not cover trusted time interval")
}

type timeCheckedTransport struct {
	base   *http.Transport
	source TrustedTimeSource
}

func (t *timeCheckedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if _, err := readTimeBounds(t.source); err != nil {
		return nil, err
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	// Also check reused connections and every redirect response. A request may
	// have been sent on an established session, but no response is released
	// when the current authority/interval no longer validates that session.
	if err = verifyTimeInterval(t.source, response.TLS); err != nil {
		response.Body.Close()
		return nil, err
	}
	return response, nil
}

func (t *timeCheckedTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }
