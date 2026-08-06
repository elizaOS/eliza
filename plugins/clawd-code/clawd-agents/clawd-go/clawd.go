// Package clawdgo provides a unified, high-level Go SDK for interacting with
// the Solana blockchain. It wraps solana-go with ergonomic APIs for wallet
// management, SOL transfers, SPL token operations, transaction handling, and
// address lookup table resolution.
//
// Zero-config quick start (no API keys needed):
//
//	clawd := clawdgo.NewDefault()
//	defer clawd.Close()
//	balance, _ := clawd.GetBalance(ctx, pubKey)       // Solana RPC via x402.wtf
//	reply, _ := clawdgo.Chat(ctx, "Hello, Solana!")    // AI chat via x402.wtf
//
// With custom endpoints:
//
//	clawd, err := clawdgo.New(clawdgo.DevNet)
//	defer clawd.Close()
//
// This package re-exports key solana-go types for convenience.
package clawdgo

import (
	"context"
	"fmt"
	"time"

	"github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/gagliardetto/solana-go/rpc/ws"

	"github.com/anthropic/clawd-go/pkg/client"
	"github.com/anthropic/clawd-go/pkg/lookup"
	"github.com/anthropic/clawd-go/pkg/token"
	"github.com/anthropic/clawd-go/pkg/transfer"
	"github.com/anthropic/clawd-go/pkg/tx"
	"github.com/anthropic/clawd-go/pkg/wallet"
	"github.com/anthropic/clawd-go/pkg/x402"
)

// Re-export commonly used solana-go types.
type (
	PublicKey          = solana.PublicKey
	PrivateKey         = solana.PrivateKey
	Signature          = solana.Signature
	Transaction        = solana.Transaction
	Instruction        = solana.Instruction
	TokenAccount       = rpc.TokenAccount
	AddressLookupTable = addresslookuptable.AddressLookupTableState

	// AI chat types.
	ChatMessage  = x402.ChatMessage
	ChatResponse = x402.ChatResponse
)

// Re-export constants.
const LamportsPerSOL = solana.LAMPORTS_PER_SOL

// Predefined clusters.
var (
	MainNetBeta = client.MainNetBeta
	TestNet     = client.TestNet
	DevNet      = client.DevNet
	LocalNet    = client.LocalNet
)

// Clawd is the top-level Solana client for clawd-go.
type Clawd struct {
	client   *client.Client
	wsClient *ws.Client

	// x402LLM is the default endpoint for AI chat (defaults to Claude).
	x402LLM string
}

// NewDefault creates a Clawd client that uses x402.wtf for both Solana RPC
// and AI chat — no API keys or configuration needed. This is the recommended
// constructor for developers who just want things to work out of the box.
//
// The RPC is routed through https://x402.wtf/api/rpc and AI through
// https://x402.wtf/api/clawd (Anthropic Claude).
func NewDefault() *Clawd {
	return &Clawd{
		client:   client.NewClientWithEndpoint(x402.EndpointRPC, ""),
		wsClient: nil,
		x402LLM:  x402.EndpointClawd,
	}
}

// NewDefaultWithLLM is like NewDefault but lets you pick the AI model endpoint.
// Use one of the x402 endpoint constants: EndpointGemini, EndpointOpenAI,
// EndpointGrok, EndpointDeepSeek, EndpointVision.
func NewDefaultWithLLM(llmEndpoint string) *Clawd {
	return &Clawd{
		client:   client.NewClientWithEndpoint(x402.EndpointRPC, ""),
		wsClient: nil,
		x402LLM:  llmEndpoint,
	}
}

// New creates a new Clawd client connected to the given cluster with the
// specified options.
func New(cluster client.Cluster, opts ...client.ClientOption) (*Clawd, error) {
	c := client.NewClient(cluster, opts...)

	// Connect the WebSocket client for transaction confirmation.
	wsClient, err := ws.Connect(context.Background(), cluster.WS)
	if err != nil {
		return nil, fmt.Errorf("connect websocket: %w", err)
	}

	return &Clawd{
		client:   c,
		wsClient: wsClient,
	}, nil
}

// NewWithoutWS creates a Clawd client without a WebSocket connection.
// Use this when you don't need transaction confirmation (e.g. read-only ops).
func NewWithoutWS(cluster client.Cluster, opts ...client.ClientOption) *Clawd {
	c := client.NewClient(cluster, opts...)
	return &Clawd{
		client:   c,
		wsClient: nil,
	}
}

// NewCustom creates a Clawd client connected to custom RPC/WS endpoints.
func NewCustom(rpcEndpoint, wsEndpoint string, opts ...client.ClientOption) (*Clawd, error) {
	c := client.NewClientWithEndpoint(rpcEndpoint, wsEndpoint, opts...)

	wsClient, err := ws.Connect(context.Background(), wsEndpoint)
	if err != nil {
		return nil, fmt.Errorf("connect websocket: %w", err)
	}

	return &Clawd{
		client:   c,
		wsClient: wsClient,
	}, nil
}

// Close terminates the WebSocket connection.
func (c *Clawd) Close() {
	if c.wsClient != nil {
		c.wsClient.Close()
	}
}

// RPC returns the underlying RPC client.
func (c *Clawd) RPC() *rpc.Client {
	return c.client.RPC
}

// WS returns the underlying WebSocket client (may be nil).
func (c *Clawd) WS() *ws.Client {
	return c.wsClient
}

// ----- AI CHAT (zero-config via x402.wtf) -----

// Chat sends a prompt to the Clawd's default AI endpoint and returns the response.
// For a NewDefault() client this is Anthropic Claude via x402.wtf.
// No API key is needed — the x402 proxy holds the credentials.
func (c *Clawd) Chat(ctx context.Context, userMessage string) (string, error) {
	return x402.QuickChatAt(ctx, c.llmEndpoint(), userMessage)
}

// ChatWithSystem sends a prompt with a system message to the AI endpoint.
func (c *Clawd) ChatWithSystem(ctx context.Context, systemPrompt string, userMessage string) (string, error) {
	resp, err := x402.ChatAt(ctx, c.llmEndpoint(), systemPrompt, userMessage)
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}

// ChatFull sends a prompt and returns the full response including model info and token usage.
func (c *Clawd) ChatFull(ctx context.Context, systemPrompt string, userMessage string) (*ChatResponse, error) {
	return x402.ChatAt(ctx, c.llmEndpoint(), systemPrompt, userMessage)
}

// ChatStream streams AI response tokens to the callback as they arrive.
func (c *Clawd) ChatStream(ctx context.Context, systemPrompt string, userMessage string, onChunk func(chunk string) error) error {
	return x402.ChatStreamAt(ctx, c.llmEndpoint(), systemPrompt, userMessage, onChunk)
}

func (c *Clawd) llmEndpoint() string {
	if c.x402LLM != "" {
		return c.x402LLM
	}
	return x402.EndpointClawd
}

// ----- PACKAGE-LEVEL AI CHAT (no client needed) -----

// Chat sends a prompt to the default AI (Claude via x402.wtf). No client needed.
func Chat(ctx context.Context, userMessage string) (string, error) {
	return x402.QuickChat(ctx, userMessage)
}

// ChatWithModel sends a prompt to a specific AI model via x402.wtf.
// endpoint: one of x402.EndpointClawd, EndpointGemini, EndpointOpenAI, etc.
func ChatWithModel(ctx context.Context, endpoint string, userMessage string) (string, error) {
	return x402.QuickChatAt(ctx, endpoint, userMessage)
}

// ChatWithSystemPrompt sends a prompt with a system message to the default AI.
func ChatWithSystemPrompt(ctx context.Context, systemPrompt string, userMessage string) (*ChatResponse, error) {
	return x402.Chat(ctx, systemPrompt, userMessage)
}

// ChatStreamDefault streams AI response tokens using the default model.
func ChatStreamDefault(ctx context.Context, userMessage string, onChunk func(chunk string) error) error {
	return x402.ChatStream(ctx, "", userMessage, onChunk)
}

// ----- WALLET -----

// NewWallet generates a new random wallet.
func NewWallet() (*wallet.Wallet, error) {
	return wallet.New()
}

// WalletFromBase58 creates a wallet from a base58 private key.
func WalletFromBase58(b58 string) (*wallet.Wallet, error) {
	return wallet.FromBase58(b58)
}

// WalletFromKeygenFile loads a wallet from a solana-keygen JSON file.
func WalletFromKeygenFile(path string) (*wallet.Wallet, error) {
	return wallet.FromKeygenFile(path)
}

// ----- SOL TRANSFERS -----

// TransferSOL sends SOL from one account to another and waits for confirmation.
func (c *Clawd) TransferSOL(ctx context.Context, from *solana.PrivateKey, to solana.PublicKey, lamports uint64) (solana.Signature, error) {
	params := transfer.TransferParams{
		From:   from,
		To:     to,
		Amount: lamports,
	}

	txx, err := transfer.BuildTransaction(ctx, c.client.RPC, params)
	if err != nil {
		return solana.Signature{}, err
	}

	if c.wsClient != nil {
		return tx.SendAndConfirm(ctx, c.client.RPC, c.wsClient, txx)
	}
	return tx.Send(ctx, c.client.RPC, txx)
}

// TransferSOLNoConfirm sends SOL without waiting for confirmation.
func (c *Clawd) TransferSOLNoConfirm(ctx context.Context, from *solana.PrivateKey, to solana.PublicKey, lamports uint64) (solana.Signature, error) {
	params := transfer.TransferParams{
		From:   from,
		To:     to,
		Amount: lamports,
	}

	txx, err := transfer.BuildTransaction(ctx, c.client.RPC, params)
	if err != nil {
		return solana.Signature{}, err
	}

	return tx.Send(ctx, c.client.RPC, txx)
}

// RequestAirdrop requests an airdrop of lamports.
func (c *Clawd) RequestAirdrop(ctx context.Context, to solana.PublicKey, lamports uint64) (solana.Signature, error) {
	return transfer.RequestAirdrop(ctx, c.client.RPC, to, lamports)
}

// ----- SPL TOKENS -----

// CreateATA creates an associated token account for the given owner/mint.
// Returns the transaction (nil if ATA already exists), the ATA public key, and error.
func (c *Clawd) CreateATA(ctx context.Context, payer *solana.PrivateKey, owner, mint solana.PublicKey) (*solana.Transaction, solana.PublicKey, error) {
	return token.CreateATA(ctx, c.client.RPC, payer, owner, mint)
}

// CreateATAAndConfirm creates an ATA, sends it, and confirms the transaction.
func (c *Clawd) CreateATAAndConfirm(ctx context.Context, payer *solana.PrivateKey, owner, mint solana.PublicKey) (solana.Signature, solana.PublicKey, error) {
	txx, ata, err := token.CreateATA(ctx, c.client.RPC, payer, owner, mint)
	if err != nil {
		return solana.Signature{}, solana.PublicKey{}, err
	}

	if txx == nil {
		return solana.Signature{}, ata, nil
	}

	if c.wsClient != nil {
		sig, err := tx.SendAndConfirm(ctx, c.client.RPC, c.wsClient, txx)
		return sig, ata, err
	}

	sig, err := tx.Send(ctx, c.client.RPC, txx)
	return sig, ata, err
}

// FindATA derives the associated token account address.
func FindATA(owner, mint solana.PublicKey) (solana.PublicKey, uint8, error) {
	return token.FindATA(owner, mint)
}

// TransferToken sends SPL tokens and waits for confirmation.
func (c *Clawd) TransferToken(ctx context.Context, params token.TransferParams) (solana.Signature, error) {
	txx, err := token.BuildTransferTransaction(ctx, c.client.RPC, params)
	if err != nil {
		return solana.Signature{}, err
	}

	if c.wsClient != nil {
		return tx.SendAndConfirm(ctx, c.client.RPC, c.wsClient, txx)
	}
	return tx.Send(ctx, c.client.RPC, txx)
}

// GetTokenBalance returns the balance of a token account.
func (c *Clawd) GetTokenBalance(ctx context.Context, tokenAccount solana.PublicKey) (*rpc.GetTokenAccountBalanceResult, error) {
	return token.GetTokenBalance(ctx, c.client.RPC, tokenAccount)
}

// GetTokenAccounts returns all token accounts owned by the given public key.
func (c *Clawd) GetTokenAccounts(ctx context.Context, owner solana.PublicKey) (*rpc.GetTokenAccountsResult, error) {
	return token.GetTokenAccountsByOwnerTokenProgram(ctx, c.client.RPC, owner)
}

// ----- TRANSACTION UTILITIES -----

// SendAndConfirm sends a transaction and waits for confirmation.
func (c *Clawd) SendAndConfirm(ctx context.Context, txx *solana.Transaction) (solana.Signature, error) {
	if c.wsClient == nil {
		return solana.Signature{}, fmt.Errorf("websocket client required for SendAndConfirm; use New() instead of NewWithoutWS()")
	}
	return tx.SendAndConfirm(ctx, c.client.RPC, c.wsClient, txx)
}

// Send submits a transaction without waiting for confirmation.
func (c *Clawd) Send(ctx context.Context, txx *solana.Transaction) (solana.Signature, error) {
	return tx.Send(ctx, c.client.RPC, txx)
}

// SendAndConfirmWithTimeout sends and confirms with a custom timeout.
func (c *Clawd) SendAndConfirmWithTimeout(ctx context.Context, txx *solana.Transaction, timeout time.Duration) (solana.Signature, error) {
	if c.wsClient == nil {
		return solana.Signature{}, fmt.Errorf("websocket client required")
	}
	return tx.SendAndConfirmWithRetry(ctx, c.client.RPC, c.wsClient, txx, rpc.CommitmentFinalized, &timeout)
}

// GetTransaction fetches a transaction by signature.
func (c *Clawd) GetTransaction(ctx context.Context, sig solana.Signature) (*solana.Transaction, error) {
	return tx.GetTransaction(ctx, c.client.RPC, sig)
}

// DecodeInstruction decodes a single instruction from a transaction.
func (c *Clawd) DecodeInstruction(txx *solana.Transaction, index int) (interface{}, error) {
	return tx.DecodeInstruction(txx, index)
}

// DecodeAllInstructions decodes every instruction in a transaction.
func (c *Clawd) DecodeAllInstructions(txx *solana.Transaction) ([]interface{}, error) {
	return tx.DecodeAllInstructions(txx)
}

// PrettyPrintTransaction prints a human-readable tree of the transaction.
func (c *Clawd) PrettyPrintTransaction(txx *solana.Transaction, title string) error {
	return tx.PrettyPrint(txx, title)
}

// TransactionString returns the pretty-printed transaction string.
func TransactionString(txx *solana.Transaction) string {
	return tx.String(txx)
}

// IsConfirmed checks if a transaction has been confirmed.
func (c *Clawd) IsConfirmed(ctx context.Context, sig solana.Signature) (bool, error) {
	return tx.IsConfirmed(ctx, c.client.RPC, sig)
}

// GetSignatureStatuses returns confirmation statuses for multiple signatures.
func (c *Clawd) GetSignatureStatuses(ctx context.Context, sigs ...solana.Signature) ([]*rpc.SignatureStatusesResult, error) {
	return tx.GetSignatureStatuses(ctx, c.client.RPC, sigs...)
}

// GetLatestBlockhash returns the latest blockhash.
func (c *Clawd) GetLatestBlockhash(ctx context.Context) (*rpc.GetLatestBlockhashResult, error) {
	return tx.GetLatestBlockhash(ctx, c.client.RPC)
}

// GetBalance returns the SOL balance for a public key.
func (c *Clawd) GetBalance(ctx context.Context, pubKey solana.PublicKey) (uint64, error) {
	return tx.GetBalance(ctx, c.client.RPC, pubKey)
}

// GetAccountInfo fetches account info for a public key.
func (c *Clawd) GetAccountInfo(ctx context.Context, pubKey solana.PublicKey) (*rpc.GetAccountInfoResult, error) {
	return tx.GetAccountInfo(ctx, c.client.RPC, pubKey)
}

// ----- ADDRESS LOOKUP TABLES -----

// ResolveLookups resolves all address table lookups in a versioned transaction.
func (c *Clawd) ResolveLookups(ctx context.Context, txx *solana.Transaction) error {
	return lookup.ResolveLookups(ctx, c.client.RPC, txx)
}

// DecodeAddressTable decodes an on-chain address lookup table.
func (c *Clawd) DecodeAddressTable(ctx context.Context, tableKey solana.PublicKey) (*addresslookuptable.AddressLookupTableState, error) {
	return lookup.DecodeTable(ctx, c.client.RPC, tableKey)
}