package otatrust

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestTUFIntervalExpiryUsesUpperBound(t *testing.T) {
	r := fixture(t)
	for _, tc := range []struct {
		name   string
		upper  int64
		accept bool
	}{
		{"before-expiry", now.Add(time.Hour).UnixMilli() - 1, true},
		{"at-expiry", now.Add(time.Hour).UnixMilli(), false},
		{"after-expiry", now.Add(2 * time.Hour).UnixMilli(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, err := FetchDescriptorInterval(privateDir(t), r.root, baseURL, "stable", "launcher", now.UnixMilli(), tc.upper, r)
			if tc.accept {
				if err != nil || !bytes.Equal(data, r.body) {
					t.Fatalf("data=%s err=%v", data, err)
				}
			} else if err == nil || data != nil {
				t.Fatal("expired upper bound accepted")
			}
		})
	}
}

func TestTUFIntervalPersistsOnlyLowerAndNarrowsAgainstFloor(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	point := now.UnixMilli()
	run := func(lower, upper int64, accept bool) {
		t.Helper()
		data, err := FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", lower, upper, r)
		if accept {
			if err != nil || !bytes.Equal(data, r.body) {
				t.Fatalf("%d..%d: %v", lower, upper, err)
			}
		} else if err == nil || data != nil {
			t.Fatal("time rollback accepted")
		}
	}
	run(point, point+60000, true)
	// A narrower fresh sample below the previous upper bound is legitimate.
	run(point+1000, point+2000, true)
	// The historical lower floor narrows an overlapping interval, never drops.
	run(point-1000, point+1500, true)
	floor, err := os.ReadFile(filepath.Join(dir, ".clock"))
	if err != nil {
		t.Fatal(err)
	}
	if string(floor) != strconv.FormatInt(point+1000, 10) {
		t.Fatalf("incorrect floor: %s", floor)
	}
	run(point-1000, point+999, false)
	// Exact-time API can reopen an interval-written cache without a reset.
	if _, err := fetch(dir, r, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
}

func TestTUFIntervalFailedExpiryDoesNotPoisonClockFloor(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	point := now.UnixMilli()
	if _, err := FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", point, point+7200000, r); err == nil {
		t.Fatal("expired metadata accepted")
	}
	if _, err := FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", point+1, point+2, r); err != nil {
		t.Fatalf("upper bound poisoned persisted floor: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, ".clock")); err != nil {
		t.Fatal(err)
	}
	if _, err := FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", point+1, point+2, r); err == nil {
		t.Fatal("missing persisted floor silently reset")
	}
}

func TestTUFIntervalInvalidBoundsDoNotTouchStorageOrNetwork(t *testing.T) {
	r := fixture(t)
	for _, bounds := range [][2]int64{{0, 1}, {-1, 1}, {2, 1}, {1, safeInteger + 1}, {safeInteger + 1, safeInteger + 1}} {
		dir := privateDir(t)
		transport := &discoveryFixture{repository: r, hook: func() { t.Fatal("invalid bounds reached transport") }}
		if data, err := FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", bounds[0], bounds[1], transport); err == nil || data != nil {
			t.Fatal("invalid bounds accepted")
		}
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 0 {
			t.Fatalf("invalid bounds mutated storage: %v %v", entries, err)
		}
	}
}
