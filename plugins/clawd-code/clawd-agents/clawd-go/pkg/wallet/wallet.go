// Package wallet provides Solana wallet creation, key management,
// and key loading utilities.
package wallet

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/gagliardetto/solana-go"
)

// Wallet wraps a Solana private key and provides convenience methods.
type Wallet struct {
	PrivateKey solana.PrivateKey
}

// New creates a new random wallet (keypair).
func New() (*Wallet, error) {
	pk, err := solana.NewRandomPrivateKey()
	if err != nil {
		return nil, fmt.Errorf("generate keypair: %w", err)
	}
	return &Wallet{PrivateKey: pk}, nil
}

// NewWallet is an alias for New (matches solana-go naming).
func NewWallet() *Wallet {
	return &Wallet{PrivateKey: solana.NewWallet().PrivateKey}
}

// FromPrivateKey creates a Wallet from an existing private key.
func FromPrivateKey(pk solana.PrivateKey) *Wallet {
	return &Wallet{PrivateKey: pk}
}

// FromBase58 creates a Wallet from a base58-encoded private key string.
func FromBase58(b58 string) (*Wallet, error) {
	pk, err := solana.PrivateKeyFromBase58(b58)
	if err != nil {
		return nil, fmt.Errorf("parse base58 private key: %w", err)
	}
	return &Wallet{PrivateKey: pk}, nil
}

// MustFromBase58 creates a Wallet from a base58-encoded private key string.
// Panics if the key is invalid.
func MustFromBase58(b58 string) *Wallet {
	pk := solana.MustPrivateKeyFromBase58(b58)
	return &Wallet{PrivateKey: pk}
}

// FromKeygenFile loads a wallet from a solana-keygen JSON file
// (generated with `solana-keygen new --outfile=<path>`).
func FromKeygenFile(path string) (*Wallet, error) {
	pk, err := solana.PrivateKeyFromSolanaKeygenFile(path)
	if err != nil {
		return nil, fmt.Errorf("load keygen file %s: %w", path, err)
	}
	return &Wallet{PrivateKey: pk}, nil
}

// FromFile loads a wallet from a JSON file containing a byte array
// (e.g. [23, 45, ...]).
func FromFile(path string) (*Wallet, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key file %s: %w", path, err)
	}

	var raw []byte
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse key file %s: %w", path, err)
	}

	if len(raw) != 64 {
		return nil, fmt.Errorf("invalid key length: expected 64 bytes, got %d", len(raw))
	}

	pk := solana.PrivateKey(raw)
	return &Wallet{PrivateKey: pk}, nil
}

// PublicKey returns the public key derived from the wallet's private key.
func (w *Wallet) PublicKey() solana.PublicKey {
	return w.PrivateKey.PublicKey()
}

// SaveToKeygenFile saves the wallet to a solana-keygen compatible JSON file.
func (w *Wallet) SaveToKeygenFile(path string) error {
	pkBytes := []byte(w.PrivateKey)
	data, err := json.MarshalIndent(pkBytes[:32], "", "  ")
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write key file: %w", err)
	}
	return nil
}

// PrivateKeyBase58 returns the base58-encoded private key string.
func (w *Wallet) PrivateKeyBase58() string {
	return w.PrivateKey.String()
}

// PublicKeyBase58 returns the base58-encoded public key string.
func (w *Wallet) PublicKeyBase58() string {
	return w.PublicKey().String()
}

// Signer returns a function compatible with solana.Transaction.Sign.
func (w *Wallet) Signer() func(key solana.PublicKey) *solana.PrivateKey {
	return func(key solana.PublicKey) *solana.PrivateKey {
		if w.PublicKey().Equals(key) {
			return &w.PrivateKey
		}
		return nil
	}
}