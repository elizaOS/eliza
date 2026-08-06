// Package transfer provides SOL transfer operations using the system program.
package transfer

import (
	"context"
	"fmt"
	"math/big"

	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/rpc"
)

// SOL represents an amount of SOL in lamports.
type SOL = uint64

// LamportsPerSOL is the number of lamports in one SOL (1 billion).
const LamportsPerSOL = solana.LAMPORTS_PER_SOL

// SOLToLamports converts a SOL floating-point amount to lamports.
func SOLToLamports(sol float64) uint64 {
	return uint64(sol * float64(LamportsPerSOL))
}

// LamportsToSOL converts lamports to SOL as a float64.
func LamportsToSOL(lamports uint64) float64 {
	return float64(lamports) / float64(LamportsPerSOL)
}

// SOLDecimal converts a string decimal SOL amount to lamports using big.Float
// to avoid floating-point precision issues.
func SOLDecimal(solStr string) (uint64, error) {
	f := new(big.Float)
	if _, ok := f.SetString(solStr); !ok {
		return 0, fmt.Errorf("invalid SOL decimal: %s", solStr)
	}
	lamportsFloat := new(big.Float).Mul(f, big.NewFloat(float64(LamportsPerSOL)))
	lamports, _ := lamportsFloat.Uint64()
	return lamports, nil
}

// TransferParams contains the parameters for a SOL transfer.
type TransferParams struct {
	From   *solana.PrivateKey
	To     solana.PublicKey
	Amount uint64 // lamports
}

// BuildInstruction creates a system.Transfer instruction without sending it.
func BuildInstruction(params TransferParams) solana.Instruction {
	return system.NewTransferInstruction(
		params.Amount,
		params.From.PublicKey(),
		params.To,
	).Build()
}

// BuildTransaction constructs a signed transaction for a SOL transfer.
// It fetches the latest blockhash from the RPC client.
func BuildTransaction(ctx context.Context, client *rpc.Client, params TransferParams) (*solana.Transaction, error) {
	recent, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, fmt.Errorf("get latest blockhash: %w", err)
	}

	tx, err := solana.NewTransaction(
		[]solana.Instruction{
			BuildInstruction(params),
		},
		recent.Value.Blockhash,
		solana.TransactionPayer(params.From.PublicKey()),
	)
	if err != nil {
		return nil, fmt.Errorf("create transaction: %w", err)
	}

	fromPubKey := params.From.PublicKey()
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if fromPubKey.Equals(key) {
			return params.From
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("sign transaction: %w", err)
	}

	return tx, nil
}

// RequestAirdrop requests an airdrop of lamports to the given public key.
func RequestAirdrop(ctx context.Context, client *rpc.Client, to solana.PublicKey, lamports uint64) (solana.Signature, error) {
	out, err := client.RequestAirdrop(ctx, to, lamports, rpc.CommitmentFinalized)
	if err != nil {
		return solana.Signature{}, fmt.Errorf("request airdrop: %w", err)
	}
	return out, nil
}