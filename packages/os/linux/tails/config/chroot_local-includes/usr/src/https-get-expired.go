package main

import (
	// "log"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var verifyOpts x509.VerifyOptions
var currentTime time.Time
var onesecond_more time.Duration
var now = time.Now()
var rejectExpired = false

func init() {
	var err error
	onesecond_more, err = time.ParseDuration("1s")
	if err != nil { // but this should never happen
		panic(err)
	}
}

// this is a porting from crypto/tls/handshake_client.go
const defaultMaxRSAKeySize = 8192

func checkKeySize(n int) (max int, ok bool) {
	// Tails: ignore the godebug tlsmaxrsasize: we are not interested in afeature flag
	return defaultMaxRSAKeySize, n <= defaultMaxRSAKeySize
}

// This function is a modified version of verifyServerCertificate, which can be found at
// https://github.com/golang/go/blob/go1.24.0/src/crypto/tls/handshake_client.go#L1082
// (from here on, this will be called "upstream")
// All changes we do are highlighted by a "// Tails:" comment
func verifyButAcceptExpired(certificates [][]byte, _verifiedChains [][]*x509.Certificate) error {
	certs := make([]*x509.Certificate, len(certificates))
	for i, asn1Data := range certificates {
		cert, err := globalCertCache.newCert(asn1Data)
		if err != nil {
			// Tails: do not sendAlert
			return errors.New("tls: failed to parse certificate from server: " + err.Error())
		}
		if cert.cert.PublicKeyAlgorithm == x509.RSA {
			n := cert.cert.PublicKey.(*rsa.PublicKey).N.BitLen()
			if max, ok := checkKeySize(n); !ok {
				// Tails: do not sendAlert
				return fmt.Errorf("tls: server sent certificate containing RSA key larger than %d bits", max)
			}
		}
		certs[i] = cert.cert
	}

	// Tails: determine the time that we want to pretend we're in
	//  After that, we'll mostly follow the original code
	fakeCurrentTime := currentTime
	if !rejectExpired || certs[0].NotBefore.After(currentTime) {
		// that's the real change: we're pretending that the time of verification is after the
		// not-before field of the leaf certificate.
		fakeCurrentTime = certs[0].NotBefore.Add(onesecond_more)
	}

	// Tails: we remove the whole "if echRejected"; we're not setting EncryptedClientHelloConfigList anyway,
	// so we're not having Encrypted Client Hello

	// Tails: we don't even check if InsecureSkipVerify is set, because we don't support it.
	// Tails: inherit opts from verifyOpts that we created in main(), but let's use our fakeCurrentTime
	opts := verifyOpts
	opts.CurrentTime = fakeCurrentTime

	for _, cert := range certs[1:] {
		opts.Intermediates.AddCert(cert)
	}
	_, err := certs[0].Verify(opts)
	if err != nil {
		// Tails: do not sendAlert
		return &tls.CertificateVerificationError{UnverifiedCertificates: certs, Err: err}
	}

	// Tails: the fipsAllowedChains block is disabled based on the reasoning that it must be enabled with
	// GODEBUG=fips140=on. See src/crypto/tls/internal/fips140tls/fipstls.go
	// fipsAllowedChains always returns chains, nil otherwise.

	switch certs[0].PublicKey.(type) {
	case *rsa.PublicKey, *ecdsa.PublicKey, ed25519.PublicKey:
		break
	default:
		// Tails: do not sendAlert
		return fmt.Errorf("tls: server's certificate contains an unsupported type of public key: %T", certs[0].PublicKey)
	}

	// Tails: we skip the "if c.config.VerifyPeerCertificate" because we're exactly that function

	// Tails: we drop the "if c.config.VerifyConnection because we're not setting it"

	return nil
}

// XXX: emulate htpdate --proxy, that is curl --socks5-hostname

func main() {
	var err error
	flag.BoolVar(&rejectExpired, "reject-expired", false, "If set, only future certificates are accepted.")
	user_agent := flag.String("user-agent", "", "Set user-agent header.")
	timeout := flag.Duration("timeout", 30*time.Second, "Request timeout.")
	proxy := flag.String("proxy", "", "Set a proxy for the request. socks5:// syntax supported")

	output_headers := flag.String("output", "", "Write date header to FILE. If omitted, date is printed on stdout.")

	currentTimeS := flag.String("current-time", "", "simulate a different current-time. Debug only!")
	flag.Parse()
	if len(*currentTimeS) > 0 {
		currentTime, err = time.Parse("2006-01-02", *currentTimeS)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Invalid format for current-time:", err.Error())
			os.Exit(2)
		}
	} else {
		currentTime = time.Now()
	}

	urlString := flag.Args()[0]
	urlRequest, err := url.Parse(urlString)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid url")
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	hostname := urlRequest.Hostname()

	config := tls.Config{VerifyPeerCertificate: verifyButAcceptExpired, InsecureSkipVerify: true, MinVersion: tls.VersionTLS10}
	transCfg := &http.Transport{
		TLSClientConfig: &config,
		Proxy: func(req *http.Request) (*url.URL, error) {
			if *proxy == "" {
				return nil, nil
			}
			return url.Parse(*proxy)
		},
	}
	verifyOpts = x509.VerifyOptions{
		Roots:         config.RootCAs,
		DNSName:       hostname,
		Intermediates: x509.NewCertPool(),
	}
	client := &http.Client{Transport: transCfg, Timeout: *timeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	request, err := http.NewRequest("HEAD", urlString, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error preparing the request")
		os.Exit(1)
	}
	if *user_agent != "" {
		request.Header.Set("User-Agent", *user_agent)
	}
	response, err := client.Do(request)

	if err != nil {
		fmt.Fprintln(os.Stderr, "Error while performing HTTP request:", err)
		os.Exit(1)
	}

	if *output_headers != "" {

		// don't output headers we don't care about
		exclude_headers := make(map[string]bool)
		for key := range response.Header {
			if strings.ToLower(key) != "date" {
				exclude_headers[key] = true
			}
		}

		buf, err := os.OpenFile(*output_headers, os.O_WRONLY|os.O_CREATE, 0600)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

		err = response.Header.WriteSubset(buf, exclude_headers)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	} else {
		fmt.Println(response.Header.Get("date"))
	}

	os.Exit(0)
}
