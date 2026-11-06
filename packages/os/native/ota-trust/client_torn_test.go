package otatrust

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// cachedFixture runs one successful session, so dir holds a complete cache.
func cachedFixture(t *testing.T) (*repository, string) {
	t.Helper()
	r := fixture(t)
	dir := privateDir(t)
	if _, err := fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	return r, dir
}

// tear keeps the first keep bytes of a file, as a crash during a write can.
func tear(t *testing.T, name string, keep int) {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(name, data[:min(keep, len(data))], 0600); err != nil {
		t.Fatal(err)
	}
}

func TestTornDescriptorDoesNotStopDiscovery(t *testing.T) {
	for _, keep := range []int{0, 5} {
		r, dir := cachedFixture(t)
		tear(t, filepath.Join(dir, "descriptor.json"), keep)
		before, _ := os.ReadFile(filepath.Join(dir, "timestamp.json"))
		data, err := fetch(dir, r, now)
		if err != nil || !bytes.Equal(data, r.body) {
			t.Fatalf("keep=%d: torn descriptor stopped discovery: %v", keep, err)
		}
		if after, _ := os.ReadFile(filepath.Join(dir, "timestamp.json")); !bytes.Equal(before, after) {
			t.Fatal("trust metadata changed")
		}
	}
}

func TestInterruptedTemporariesDiscarded(t *testing.T) {
	r, dir := cachedFixture(t)
	for _, name := range []string{"tuf_tmp123", "clock_tmp456"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(`{"half`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tuf_tmp123", "clock_tmp456"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s retained", name)
		}
	}
}

// Metadata holds rollback floors, so a torn file is refused and reported as a
// trust-cache failure, never removed or reset to the pinned root.
func TestTornMetadataFailsClosedAsTrustCache(t *testing.T) {
	for _, name := range []string{"root.json", "timestamp.json", "snapshot.json", "targets.json", "stable.json", ".clock"} {
		r, dir := cachedFixture(t)
		tear(t, filepath.Join(dir, name), 0)
		if _, err := fetch(dir, r, now); !errors.Is(err, errTrustCache) {
			t.Fatalf("%s torn: %v", name, err)
		}
		if _, err := os.Lstat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s was removed", name)
		}
	}
}

func TestDescriptorSymlinkStillRefused(t *testing.T) {
	r, dir := cachedFixture(t)
	os.Remove(filepath.Join(dir, "descriptor.json"))
	if err := os.Symlink(filepath.Join(dir, "root.json"), filepath.Join(dir, "descriptor.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := fetch(dir, r, now); !errors.Is(err, errTrustCache) {
		t.Fatal("symlink accepted", err)
	}
}

func TestDiscoveryReportsTrustCacheFailure(t *testing.T) {
	run := func(cache string, r *repository) *DiscoveryResult {
		t.Helper()
		schedule, _ := discoveryDirs(t)
		s := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
		result, err := s.Run(schedule, cache, r.root, baseURL, "stable", "launcher", 0)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	r, dir := cachedFixture(t)
	tear(t, filepath.Join(dir, "root.json"), 0)
	if result := run(dir, r); result.Status != "deferred" || result.Failure != "trust-cache" || len(result.Descriptor) != 0 {
		t.Fatalf("torn root: %+v", result)
	}
	offline := fixture(t)
	offline.files = map[string][]byte{}
	if result := run(privateDir(t), offline); result.Status != "deferred" || result.Failure != "fetch" {
		t.Fatalf("missing repository: %+v", result)
	}
	if result := run(privateDir(t), fixture(t)); result.Status != "authenticated" || result.Failure != "" {
		t.Fatalf("healthy: %+v", result)
	}
}

// An I/O failure may pass, so it is an ordinary failure, never a trust cache
// that no retry repairs. Only the check before a session reads the cache
// reports a refused entry as trust-cache.
func TestCacheIOFailureIsNotTrustCache(t *testing.T) {
	r, dir := cachedFixture(t)
	if err := os.Chmod(dir, 0300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0700) })
	if _, err := os.ReadDir(dir); err == nil {
		t.Skip("directory still readable (running as root?)")
	}
	if _, err := fetch(dir, r, now); err == nil || errors.Is(err, errTrustCache) {
		t.Fatal("unreadable directory:", err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "snapshot.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := syncCache(dir, false); err == nil || errors.Is(err, errTrustCache) {
		t.Fatal("in-session sync:", err)
	}
	if err := syncCache(dir, true); !errors.Is(err, errTrustCache) {
		t.Fatal("pre-session check:", err)
	}
}
