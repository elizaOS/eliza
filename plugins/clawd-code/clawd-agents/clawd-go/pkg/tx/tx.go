// Package tx provides transaction utilities: sending, confirming, decoding,
// and pretty-printing Solana transactions.
package tx

import (
	"context"
	"fmt"
	"os"
	"time"

	bin "github.com/gagliardetto/binary"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	confirm "github.com/gagliardetto/solana-go/rpc/sendAndConfirmTransaction"
	"github.com/gagliardetto/solana-go/text"
	"github.com/gagliardetto/solana-go/rpc/ws"
)

// SendAndConfirm sends a transaction and waits for its confirmation.
// Requires both an RPC client and a WebSocket client for confirmation.
func SendAndConfirm(ctx context.Context, rpcClient *rpc.Client, wsClient *ws.Client, tx *solana.Transaction) (solana.Signature, error) {
	sig, err := confirm.SendAndConfirmTransaction(ctx, rpcClient, wsClient, tx)
	if err != nil {
		return solana.Signature{}, fmt.Errorf("send and confirm: %w", err)
	}
	return sig, nil
}

// Send submits a transaction without waiting for confirmation.
func Send(ctx context.Context, rpcClient *rpc.Client, tx *solana.Transaction) (solana.Signature, error) {
	sig, err := rpcClient.SendTransactionWithOpts(
		ctx,
		tx,
		rpc.TransactionOpts{
			PreflightCommitment: rpc.CommitmentProcessed,
		},
	)
	if err != nil {
		return solana.Signature{}, fmt.Errorf("send transaction: %w", err)
	}
	return sig, nil
}

// SendAndConfirmWithRetry sends and confirms with configurable retry options.
// commitment: the desired confirmation commitment level (e.g. rpc.CommitmentFinalized).
// timeout: optional timeout duration; if nil, defaults to 2 minutes.
func SendAndConfirmWithRetry(ctx context.Context, rpcClient *rpc.Client, wsClient *ws.Client, tx *solana.Transaction, commitment rpc.CommitmentType, timeout *time.Duration) (solana.Signature, error) {
	sig, err := confirm.SendAndConfirmTransactionWithOpts(
		ctx,
		rpcClient,
		wsClient,
		tx,
		rpc.TransactionOpts{
			SkipPreflight:       false,
			PreflightCommitment: commitment,
		},
		timeout,
	)
	if err != nil {
		return solana.Signature{}, fmt.Errorf("send and confirm with retry: %w", err)
	}
	return sig, nil
}

// GetTransaction fetches a confirmed transaction by its signature.
func GetTransaction(ctx context.Context, client *rpc.Client, sig solana.Signature) (*solana.Transaction, error) {
	version := uint64(0)
	out, err := client.GetTransaction(
		ctx,
		sig,
		&rpc.GetTransactionOpts{
			MaxSupportedTransactionVersion: &version,
			Encoding:                       solana.EncodingBase64,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("get transaction: %w", err)
	}

	tx, err := solana.TransactionFromDecoder(bin.NewBinDecoder(out.Transaction.GetBinary()))
	if err != nil {
		return nil, fmt.Errorf("decode transaction: %w", err)
	}

	return tx, nil
}

// DecodeInstruction decodes a single instruction from a transaction using the
// central instruction registry. Returns the decoded instruction as interface{}
// (cast to the appropriate type, e.g. *system.Transfer).
func DecodeInstruction(tx *solana.Transaction, index int) (interface{}, error) {
	if index < 0 || index >= len(tx.Message.Instructions) {
		return nil, fmt.Errorf("instruction index %d out of range (0-%d)", index, len(tx.Message.Instructions)-1)
	}

	i0 := tx.Message.Instructions[index]

	progKey, err := tx.ResolveProgramIDIndex(i0.ProgramIDIndex)
	if err != nil {
		return nil, fmt.Errorf("resolve program id index: %w", err)
	}

	accounts, err := i0.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return nil, fmt.Errorf("resolve instruction accounts: %w", err)
	}

	decoded, err := solana.DecodeInstruction(progKey, accounts, i0.Data)
	if err != nil {
		return nil, fmt.Errorf("decode instruction: %w", err)
	}

	return decoded, nil
}

// DecodeAllInstructions decodes every instruction in a transaction.
func DecodeAllInstructions(tx *solana.Transaction) ([]interface{}, error) {
	var results []interface{}
	for i := range tx.Message.Instructions {
		decoded, err := DecodeInstruction(tx, i)
		if err != nil {
			return nil, fmt.Errorf("decode instruction %d: %w", i, err)
		}
		results = append(results, decoded)
	}
	return results, nil
}

// PrettyPrint writes a human-readable tree of the transaction to stdout.
func PrettyPrint(tx *solana.Transaction, title string) error {
	return PrettyPrintTo(tx, title, os.Stdout)
}

// PrettyPrintTo writes a human-readable tree of the transaction to the given writer.
func PrettyPrintTo(tx *solana.Transaction, title string, w *os.File) error {
	_, err := tx.EncodeTree(text.NewTreeEncoder(w, text.Bold(title)))
	if err != nil {
		return fmt.Errorf("pretty print: %w", err)
	}
	return nil
}

// String returns the pretty-printed transaction as a string.
func String(tx *solana.Transaction) string {
	return tx.String()
}

// GetSignatureStatuses returns the confirmation status for a batch of signatures.
func GetSignatureStatuses(ctx context.Context, client *rpc.Client, sigs ...solana.Signature) ([]*rpc.SignatureStatusesResult, error) {
	result, err := client.GetSignatureStatuses(ctx, true, sigs...)
	if err != nil {
		return nil, fmt.Errorf("get signature statuses: %w", err)
	}
	return result.Value, nil
}

// IsConfirmed returns true if the given signature has been confirmed.
func IsConfirmed(ctx context.Context, client *rpc.Client, sig solana.Signature) (bool, error) {
	statuses, err := GetSignatureStatuses(ctx, client, sig)
	if err != nil {
		return false, err
	}
	if len(statuses) == 0 || statuses[0] == nil {
		return false, nil
	}
	return statuses[0].ConfirmationStatus != rpc.ConfirmationStatusProcessed, nil
}

// GetLatestBlockhash is a convenience wrapper for fetching the latest blockhash.
func GetLatestBlockhash(ctx context.Context, client *rpc.Client) (*rpc.GetLatestBlockhashResult, error) {
	result, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, fmt.Errorf("get latest blockhash: %w", err)
	}
	return result, nil
}

// GetBalance returns the SOL balance (in lamports) for a given public key.
func GetBalance(ctx context.Context, client *rpc.Client, pubKey solana.PublicKey) (uint64, error) {
	result, err := client.GetBalance(ctx, pubKey, rpc.CommitmentProcessed)
	if err != nil {
		return 0, fmt.Errorf("get balance: %w", err)
	}
	return result.Value, nil
}

// GetAccountInfo fetches the account info for a given public key.
func GetAccountInfo(ctx context.Context, client *rpc.Client, pubKey solana.PublicKey) (*rpc.GetAccountInfoResult, error) {
	result, err := client.GetAccountInfo(ctx, pubKey)
	if err != nil {
		return nil, fmt.Errorf("get account info: %w", err)
	}
	return result, nil
}