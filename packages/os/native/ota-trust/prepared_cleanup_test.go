package otatrust

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func addPrepared(t *testing.T, directory, base string, generation int64) string {
	t.Helper()
	record, err := readPrepared(directory, base)
	if err != nil {
		t.Fatal(err)
	}
	record.Generation = generation
	id, err := admissionHash(record)
	if err != nil {
		t.Fatal(err)
	}
	if err = writePrepared(directory, filepath.Join(directory, id+".json"), *record, nil); err != nil {
		t.Fatal(err)
	}
	return id
}
func TestPreparedCleanupRetainsRecoveryAndAvoidsExhaustion(t *testing.T) {
	dir, state, id, v := preparedFixture(t)
	for i := int64(1); i < 32; i++ {
		addPrepared(t, dir, id, i)
	}
	var device admissionDevice
	var policy admissionPolicy
	json.Unmarshal(v.Device, &device)
	json.Unmarshal(v.Policy, &policy)
	if _, err := persistPreparedAuthorization(dir, v.Release, device, policy, 32); err == nil {
		t.Fatal("cap not enforced")
	}
	removed, err := PrunePreparedAuthorizations(dir, id)
	if err != nil || removed != 31 {
		t.Fatalf("prune: %d %v", removed, err)
	}
	if _, err = loadRecovery(dir, state, id); err != nil {
		t.Fatal("active recovery lost", err)
	}
	for i := int64(32); i < 132; i++ {
		if _, err = persistPreparedAuthorization(dir, v.Release, device, policy, i); err != nil {
			t.Fatal(err)
		}
		if removed, err = PrunePreparedAuthorizations(dir, id); err != nil || removed != 1 {
			t.Fatalf("%d %v", removed, err)
		}
	}
	if removed, err = PrunePreparedAuthorizations(dir, id); err != nil || removed != 0 {
		t.Fatal("cleanup not idempotent", err)
	}
	if _, err = loadRecovery(dir, state, id); err != nil {
		t.Fatal(err)
	}
}
func TestPreparedCleanupRejectsUnsafeInventoryBeforeDeleting(t *testing.T) {
	for _, mode := range []string{"unknown", "protected-corrupt", "symlink", "temporary-symlink", "protected-missing", "protected-invalid", "too-many"} {
		t.Run(mode, func(t *testing.T) {
			dir, _, id, _ := preparedFixture(t)
			other := addPrepared(t, dir, id, 1)
			keep := id
			switch mode {
			case "unknown":
				os.WriteFile(filepath.Join(dir, "other-data"), []byte("keep"), 0600)
			case "protected-corrupt":
				os.WriteFile(filepath.Join(dir, id+".json"), []byte("{}"), 0600)
			case "symlink":
				os.Remove(filepath.Join(dir, other+".json"))
				os.Symlink("missing", filepath.Join(dir, other+".json"))
			case "temporary-symlink":
				os.Symlink("missing", filepath.Join(dir, "prepared.tmp"))
			case "protected-missing":
				keep = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			case "protected-invalid":
				keep = "../outside"
			case "too-many":
				for i := int64(2); i < 35; i++ {
					addPrepared(t, dir, id, i)
				}
			}
			before, _ := os.ReadDir(dir)
			if n, err := PrunePreparedAuthorizations(dir, keep); err == nil || n != 0 {
				t.Fatal("unsafe cleanup", n, err)
			}
			after, _ := os.ReadDir(dir)
			if len(before) != len(after) {
				t.Fatal("partial deletion before validation")
			}
			if mode != "protected-corrupt" {
				if _, err := readPrepared(dir, id); err != nil {
					t.Fatal("protected record changed", err)
				}
			}
		})
	}
}
func TestPreparedCleanupLockAndAbandonedPublication(t *testing.T) {
	dir, _, id, _ := preparedFixture(t)
	if err := lockedPrepared(dir, func() error {
		if _, err := PrunePreparedAuthorizations(dir, id); err == nil {
			t.Fatal("concurrent cleanup not fenced")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "prepared.tmp"), []byte("partial"), 0600)
	if n, err := PrunePreparedAuthorizations(dir, id); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if n, err := PrunePreparedAuthorizations(dir, ""); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if n, err := PrunePreparedAuthorizations(dir, ""); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
func TestPreparedCleanupKilledProcess(t *testing.T) {
	if dir := os.Getenv("OTA_PRUNE_KILL_DIR"); dir != "" {
		_, err := prunePrepared(dir, os.Getenv("OTA_PRUNE_KEEP"), func(point string) {
			if point == os.Getenv("OTA_PRUNE_POINT") {
				os.Exit(45)
			}
		})
		t.Fatalf("kill boundary missed: %v", err)
	}
	for _, point := range []string{"validated", "unlinked", "synced"} {
		t.Run(point, func(t *testing.T) {
			dir, state, id, _ := preparedFixture(t)
			addPrepared(t, dir, id, 1)
			addPrepared(t, dir, id, 2)
			child := exec.Command(os.Args[0], "-test.run=^TestPreparedCleanupKilledProcess$")
			child.Env = append(os.Environ(), "OTA_PRUNE_KILL_DIR="+dir, "OTA_PRUNE_KEEP="+id, "OTA_PRUNE_POINT="+point)
			err := child.Run()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 45 {
				t.Fatalf("child %v", err)
			}
			if _, err = loadRecovery(dir, state, id); err != nil {
				t.Fatal("recovery lost after killed cleanup", err)
			}
			if _, err = PrunePreparedAuthorizations(dir, id); err != nil {
				t.Fatal("cleanup cannot resume", err)
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 2 {
				t.Fatal("unexpected retained entries", len(entries))
			}
		})
	}
}

func TestPreparedCleanupRepairsOnlyUnreferencedCorruptRecords(t *testing.T) {
	dir, state, id, _ := preparedFixture(t)
	other := addPrepared(t, dir, id, 1)
	os.WriteFile(filepath.Join(dir, other+".json"), []byte("corrupt"), 0600)
	if n, err := PrunePreparedAuthorizations(dir, id); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if _, err := loadRecovery(dir, state, id); err != nil {
		t.Fatal(err)
	}
	// Oversized obsolete data is not read into memory or parsed.
	file, err := os.OpenFile(filepath.Join(dir, other+".json"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(maxBytes + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if n, err := PrunePreparedAuthorizations(dir, id); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if _, err := loadRecovery(dir, state, id); err != nil {
		t.Fatal(err)
	}
}
