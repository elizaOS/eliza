package otatrust

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// PrunePreparedAuthorizations removes only updater-owned, unreferenced records.
// The Android caller MUST hold the journal lock through this operation and pass
// its current plan ID (including healthy/support states), or empty for no plan.
// Journal admission must validate the selected record under that same lock:
// a discovery result deleted before admission is retried, never committed.
func PrunePreparedAuthorizations(directory, protectedIdentity string) (int64, error) {
	return prunePrepared(directory, protectedIdentity, nil)
}
func prunePrepared(directory, protectedIdentity string, fault func(string)) (removed int64, err error) {
	if protectedIdentity != "" && !validHex(protectedIdentity) {
		return 0, errors.New("invalid protected authorization")
	}
	err = lockedPrepared(directory, func() error {
		if protectedIdentity != "" {
			if _, err := readPrepared(directory, protectedIdentity); err != nil {
				return err
			}
		}
		dir, err := os.Open(directory)
		if err != nil {
			return err
		}
		defer dir.Close()
		// Bounded read, including the lock and one interrupted publication file.
		entries, err := dir.ReadDir(35)
		if err != nil && err != io.EOF {
			return err
		}
		if len(entries) > 34 {
			return errors.New("authorization directory entry limit")
		}
		names := make([]string, 0, len(entries))
		// Validate ownership and inode types before any destructive operation.
		// The protected record was fully authenticated above. Unreferenced regular
		// cache records may be corrupt or oversized: deleting their exact owned
		// names lets discovery repair them without blocking all future updates.
		for _, entry := range entries {
			name := entry.Name()
			if name == ".prepared.lock" {
				continue
			}
			if name == "prepared.tmp" {
				stat, e := os.Lstat(filepath.Join(directory, name))
				if e != nil || !stat.Mode().IsRegular() || stat.Size() > maxBytes {
					return errors.New("unsafe abandoned authorization")
				}
				names = append(names, name)
				continue
			}
			id := strings.TrimSuffix(name, ".json")
			if name != id+".json" || !validHex(id) {
				return errors.New("unknown authorization entry")
			}
			stat, e := os.Lstat(filepath.Join(directory, name))
			if e != nil || !stat.Mode().IsRegular() {
				return errors.New("unsafe authorization cache entry")
			}
			if id != protectedIdentity {
				names = append(names, name)
			}
		}
		if fault != nil {
			fault("validated")
		}
		for _, name := range names {
			if err = os.Remove(filepath.Join(directory, name)); err != nil {
				return err
			}
			removed++
			if fault != nil {
				fault("unlinked")
			}
		}
		// A crash before directory sync may resurrect obsolete records, never erase
		// the protected one. Repeating this bounded operation is safe.
		if err = dir.Sync(); err != nil {
			return err
		}
		if fault != nil {
			fault("synced")
		}
		return nil
	})
	return removed, err
}
