// Package client provides Solana RPC and WebSocket client configuration
// with support for rate limiting, custom headers, and timeouts.
package client

import (
	"context"
	"net"
	"net/http"
	"time"

	"github.com/gagliardetto/solana-go/rpc"
	"github.com/gagliardetto/solana-go/rpc/jsonrpc"
	"golang.org/x/time/rate"
)

// Cluster represents a Solana cluster endpoint pair (RPC + WS).
type Cluster struct {
	Name string
	RPC  string
	WS   string
}

// Predefined Solana clusters.
var (
	MainNetBeta = Cluster{
		Name: "mainnet-beta",
		RPC:  rpc.MainNetBeta.RPC,
		WS:   rpc.MainNetBeta_WS,
	}
	TestNet = Cluster{
		Name: "testnet",
		RPC:  rpc.TestNet_RPC,
		WS:   rpc.TestNet_WS,
	}
	DevNet = Cluster{
		Name: "devnet",
		RPC:  rpc.DevNet_RPC,
		WS:   rpc.DevNet_WS,
	}
	LocalNet = Cluster{
		Name: "localhost",
		RPC:  rpc.LocalNet_RPC,
		WS:   rpc.LocalNet_WS,
	}
)

// Client wraps the Solana RPC client with optional WebSocket support.
type Client struct {
	RPC *rpc.Client
	WS  string // WebSocket endpoint for transaction confirmation
}

// ClientOption configures a Client.
type ClientOption func(*clientConfig)

type clientConfig struct {
	rateLimit    rate.Limit
	rateBurst    int
	headers      map[string]string
	httpTimeout  time.Duration
	maxIdleConns int
	keepAlive    time.Duration
}

// WithRateLimit sets rate limiting on the RPC client.
// limit is the maximum requests per second; burst is the allowed burst size.
func WithRateLimit(limitRequestsPerSec float64, burst int) ClientOption {
	return func(c *clientConfig) {
		c.rateLimit = rate.Limit(limitRequestsPerSec)
		c.rateBurst = burst
	}
}

// WithHeaders adds custom HTTP headers to every RPC request (e.g. API keys).
func WithHeaders(headers map[string]string) ClientOption {
	return func(c *clientConfig) {
		c.headers = headers
	}
}

// WithHTTPTimeout sets the HTTP client timeout.
func WithHTTPTimeout(d time.Duration) ClientOption {
	return func(c *clientConfig) {
		c.httpTimeout = d
	}
}

// WithMaxIdleConns configures the max idle connections per host.
func WithMaxIdleConns(n int) ClientOption {
	return func(c *clientConfig) {
		c.maxIdleConns = n
	}
}

// WithKeepAlive sets the TCP keep-alive duration.
func WithKeepAlive(d time.Duration) ClientOption {
	return func(c *clientConfig) {
		c.keepAlive = d
	}
}

// NewClient creates a new Solana RPC client connected to the given cluster
// with the provided options. It also stores the WebSocket endpoint for later
// use (e.g. transaction confirmation).
func NewClient(cluster Cluster, opts ...ClientOption) *Client {
	cfg := &clientConfig{
		rateLimit:    0, // unlimited by default
		rateBurst:    1,
		httpTimeout:  25 * time.Second,
		maxIdleConns: 10,
		keepAlive:    180 * time.Second,
	}
	for _, o := range opts {
		o(cfg)
	}

	httpClient := newHTTPClient(cfg.httpTimeout, cfg.maxIdleConns, cfg.keepAlive)

	optsJSON := &jsonrpc.RPCClientOpts{
		HTTPClient:  httpClient,
		CustomHeaders: cfg.headers,
	}

	var rpcClient *rpc.Client
	if cfg.rateLimit > 0 {
		limiter := rpc.NewWithLimiter(
			cluster.RPC,
			rate.Every(time.Second/time.Duration(cfg.rateLimit)),
			cfg.rateBurst,
		)
		rpcClient = rpc.NewWithCustomRPCClient(limiter)
	} else if len(cfg.headers) > 0 {
		rpcClient = rpc.NewWithHeaders(cluster.RPC, cfg.headers)
	} else {
		jsonRPCClient := jsonrpc.NewClientWithOpts(cluster.RPC, optsJSON)
		rpcClient = rpc.NewWithCustomRPCClient(jsonRPCClient)
	}

	return &Client{
		RPC: rpcClient,
		WS:  cluster.WS,
	}
}

// NewClientWithEndpoint creates a client connected to a custom RPC endpoint
// (not one of the predefined clusters).
func NewClientWithEndpoint(rpcEndpoint, wsEndpoint string, opts ...ClientOption) *Client {
	cluster := Cluster{
		Name: "custom",
		RPC:  rpcEndpoint,
		WS:   wsEndpoint,
	}
	return NewClient(cluster, opts...)
}

// ContextWithTimeout returns a context with the given timeout.
func ContextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func newHTTPClient(timeout time.Duration, maxIdleConnsPerHost int, keepAlive time.Duration) *http.Client {
	tr := &http.Transport{
		IdleConnTimeout:     timeout,
		MaxIdleConnsPerHost: maxIdleConnsPerHost,
		Proxy:               http.ProxyFromEnvironment,
		Dial: (&net.Dialer{
			Timeout:   timeout,
			KeepAlive: keepAlive,
		}).Dial,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
	}
}