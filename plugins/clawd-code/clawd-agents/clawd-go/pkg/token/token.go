// Package token provides SPL token operations including transfers, balance
// queries, creating token accounts, and working with associated token accounts.
package token

import (
	"context"
	"fmt"
	"math/big"

	"github.com/gagliardetto/solana-go"
	associatedtokenaccount "github.com/gagliardetto/solana-go/programs/associated-token-account"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"
)

// TransferParams contains parameters for an SPL token transfer.
type TransferParams struct {
	From   *solana.PrivateKey // owner of the source token account
	To     solana.PublicKey   // recipient's token account
	Mint   solana.PublicKey   // SPL token mint address
	Amount uint64             // raw amount (in base units, adjusted for decimals)
}

// CreateATA creates an associated token account for the given owner and mint.
// Returns the transaction (nil if ATA already exists), the ATA public key,
// and any error. The payer is the account that will pay for the creation.
// The caller must send and confirm the returned transaction themselves.
func CreateATA(ctx context.Context, client *rpc.Client, payer *solana.PrivateKey, owner, mint solana.PublicKey) (*solana.Transaction, solana.PublicKey, error) {
	ata, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	if err != nil {
		return nil, solana.PublicKey{}, fmt.Errorf("find ATA: %w", err)
	}

	// Check if ATA already exists
	_, err = client.GetAccountInfo(ctx, ata)
	if err == nil {
		// ATA already exists — no transaction needed
		return nil, ata, nil
	}

	recent, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, solana.PublicKey{}, fmt.Errorf("get latest blockhash: %w", err)
	}

	inst := associatedtokenaccount.NewCreateInstruction(
		payer.PublicKey(),
		owner,
		mint,
	).Build()

	tx, err := solana.NewTransaction(
		[]solana.Instruction{inst},
		recent.Value.Blockhash,
		solana.TransactionPayer(payer.PublicKey()),
	)
	if err != nil {
		return nil, solana.PublicKey{}, fmt.Errorf("create transaction: %w", err)
	}

	payerPub := payer.PublicKey()
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if payerPub.Equals(key) {
			return payer
		}
		return nil
	})
	if err != nil {
		return nil, solana.PublicKey{}, fmt.Errorf("sign: %w", err)
	}

	return tx, ata, nil
}

// FindATA derives the associated token account address for an owner and mint.
func FindATA(owner, mint solana.PublicKey) (solana.PublicKey, uint8, error) {
	return solana.FindAssociatedTokenAddress(owner, mint)
}

// MustFindATA panics if FindATA returns an error.
func MustFindATA(owner, mint solana.PublicKey) solana.PublicKey {
	ata, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	if err != nil {
		panic(err)
	}
	return ata
}

// BuildTransferInstruction creates an SPL token transfer instruction.
func BuildTransferInstruction(params TransferParams) solana.Instruction {
	return token.NewTransferInstruction(
		params.Amount,
		params.From.PublicKey(),
		params.To,
		params.To, // authority
		[]solana.PublicKey{},
	).Build()
}

// BuildTransferTransaction creates a signed transaction for an SPL token transfer.
func BuildTransferTransaction(ctx context.Context, client *rpc.Client, params TransferParams) (*solana.Transaction, error) {
	recent, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, fmt.Errorf("get latest blockhash: %w", err)
	}

	tx, err := solana.NewTransaction(
		[]solana.Instruction{
			BuildTransferInstruction(params),
		},
		recent.Value.Blockhash,
		solana.TransactionPayer(params.From.PublicKey()),
	)
	if err != nil {
		return nil, fmt.Errorf("create transaction: %w", err)
	}

	fromPub := params.From.PublicKey()
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if fromPub.Equals(key) {
			return params.From
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}

	return tx, nil
}

// GetTokenBalance returns the token balance for a given token account.
// Returns the raw amount (including decimals).
func GetTokenBalance(ctx context.Context, client *rpc.Client, tokenAccount solana.PublicKey) (*rpc.GetTokenAccountBalanceResult, error) {
	result, err := client.GetTokenAccountBalance(ctx, tokenAccount, rpc.CommitmentProcessed)
	if err != nil {
		return nil, fmt.Errorf("get token account balance: %w", err)
	}
	return result, nil
}

// GetTokenAccountsByOwner returns all token accounts owned by the given public key
// for the given program (typically solana.TokenProgramID).
func GetTokenAccountsByOwner(ctx context.Context, client *rpc.Client, owner solana.PublicKey, programID solana.PublicKey) (*rpc.GetTokenAccountsResult, error) {
	accounts, err := client.GetTokenAccountsByOwner(ctx, owner, &rpc.GetTokenAccountsConfig{
		ProgramId: &programID,
	}, &rpc.GetTokenAccountsOpts{
		Encoding: solana.EncodingJSONParsed,
	})
	if err != nil {
		return nil, fmt.Errorf("get token accounts: %w", err)
	}
	return accounts, nil
}

// GetTokenAccountsByOwnerTokenProgram returns all SPL Token accounts owned by the
// given public key (convenience wrapper using TokenProgramID).
func GetTokenAccountsByOwnerTokenProgram(ctx context.Context, client *rpc.Client, owner solana.PublicKey) (*rpc.GetTokenAccountsResult, error) {
	return GetTokenAccountsByOwner(ctx, client, owner, solana.TokenProgramID)
}

// HumanAmount converts a raw token amount (with decimals applied) to a human-readable float.
func HumanAmount(rawAmount uint64, decimals uint8) float64 {
	divisor := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	raw := new(big.Float).SetUint64(rawAmount)
	result := new(big.Float).Quo(raw, divisor)
	f, _ := result.Float64()
	return f
}

// RawAmount converts a human-readable amount to raw units using the given decimals.
func RawAmount(humanAmount float64, decimals uint8) uint64 {
	multiplier := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	human := new(big.Float).SetFloat64(humanAmount)
	result := new(big.Float).Mul(human, multiplier)
	raw, _ := result.Uint64()
	return raw
}

// RawAmountDecimal converts a string decimal amount to raw units.
func RawAmountDecimal(amountStr string, decimals uint8) (uint64, error) {
	f := new(big.Float)
	if _, ok := f.SetString(amountStr); !ok {
		return 0, fmt.Errorf("invalid decimal: %s", amountStr)
	}
	multiplier := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	result := new(big.Float).Mul(f, multiplier)
	raw, _ := result.Uint64()
	return raw, nil
}