// Package lookup provides address lookup table utilities for resolving
// address table lookups in versioned transactions.
package lookup

import (
	"context"
	"fmt"

	"github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
)

// Table is an alias for AddressLookupTableState.
type Table = addresslookuptable.AddressLookupTableState

// DecodeTable decodes an on-chain address lookup table account.
func DecodeTable(ctx context.Context, client *rpc.Client, tableKey solana.PublicKey) (*addresslookuptable.AddressLookupTableState, error) {
	info, err := client.GetAccountInfo(ctx, tableKey)
	if err != nil {
		return nil, fmt.Errorf("get account info for table %s: %w", tableKey, err)
	}

	tableContent, err := addresslookuptable.DecodeAddressLookupTableState(info.GetBinary())
	if err != nil {
		return nil, fmt.Errorf("decode address lookup table state: %w", err)
	}

	return tableContent, nil
}

// ResolveLookups resolves all address table lookups in a versioned transaction.
// It fetches each lookup table from the chain and populates the address tables
// in the transaction message, then resolves the lookups.
func ResolveLookups(ctx context.Context, client *rpc.Client, tx *solana.Transaction) error {
	if !tx.Message.IsVersioned() {
		return fmt.Errorf("transaction is not versioned; only versioned transactions can contain lookups")
	}

	tblKeys := tx.Message.GetAddressTableLookups().GetTableIDs()
	if len(tblKeys) == 0 {
		return nil // no lookup tables to resolve
	}

	numLookups := tx.Message.GetAddressTableLookups().NumLookups()
	if numLookups == 0 {
		return nil // no lookups to resolve
	}

	resolutions := make(map[solana.PublicKey]solana.PublicKeySlice)
	for _, key := range tblKeys {
		tableContent, err := DecodeTable(ctx, client, key)
		if err != nil {
			return fmt.Errorf("decode table %s: %w", key, err)
		}

		resolutions[key] = tableContent.Addresses
	}

	err := tx.Message.SetAddressTables(resolutions)
	if err != nil {
		return fmt.Errorf("set address tables: %w", err)
	}

	err = tx.Message.ResolveLookups()
	if err != nil {
		return fmt.Errorf("resolve lookups: %w", err)
	}

	return nil
}

// GetAddressTableLookups extracts address table lookup keys from a versioned transaction.
func GetAddressTableLookups(tx *solana.Transaction) ([]solana.PublicKey, error) {
	if !tx.Message.IsVersioned() {
		return nil, fmt.Errorf("transaction is not versioned")
	}
	return tx.Message.GetAddressTableLookups().GetTableIDs(), nil
}

// NumLookups returns the number of address lookups in a versioned transaction.
func NumLookups(tx *solana.Transaction) int {
	if !tx.Message.IsVersioned() {
		return 0
	}
	return tx.Message.GetAddressTableLookups().NumLookups()
}

// HasLookups returns true if the transaction contains address table lookups.
func HasLookups(tx *solana.Transaction) bool {
	return NumLookups(tx) > 0
}