package otatrust

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sourceStager(t *testing.T, f *stagingFixture, source TrustedTimeSource) *PreparedStager {
	t.Helper()
	s := f.newStager(t)
	s.source = source
	base := s.downloader.transport.client.Transport.(*http.Transport)
	configureIntervalTLS(base.TLSClientConfig, source)
	s.downloader.transport.client.Transport = &timeCheckedTransport{base: base, source: source}
	return s
}
func stageWithSource(f *stagingFixture, s *PreparedStager) (*StagedPair, error) {
	return s.StageWithTimeSource(f.prepared, f.admission, f.cache, f.id, f.device, 1, 0, 1024)
}
func stagingClock() *fixtureTimeSource {
	return &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli() + 1000}}
}

func TestSourceStagingDownloadsAndReusesPair(t *testing.T) {
	f := stageFixture(t)
	source := stagingClock()
	pair, err := stageWithSource(f, sourceStager(t, f, source))
	if err != nil || pair.AuthorizationID != f.id {
		t.Fatalf("%+v %v", pair, err)
	}
	f.mu.Lock()
	order := strings.Join(f.order, ",")
	f.mu.Unlock()
	if order != "recovery,candidate" {
		t.Fatal(order)
	}
	source.set(now.UnixMilli()+1, now.UnixMilli()+2, nil)
	cached, err := stageWithSource(f, sourceStager(t, f, source))
	if err != nil || cached.CandidatePath != pair.CandidatePath {
		t.Fatalf("narrower clock/cache failed: %+v %v", cached, err)
	}
}

func TestSourceStagingExpiryDuringRecoveryStopsCandidate(t *testing.T) {
	f := stageFixture(t)
	source := stagingClock()
	expires, _ := releaseTime(f.descriptor.Rollout.Expires)
	f.hook = func(name string) {
		if name == "recovery" {
			source.set(now.UnixMilli()+1000, expires, nil)
		}
	}
	if pair, err := stageWithSource(f, sourceStager(t, f, source)); err == nil || pair != nil {
		t.Fatalf("expiry accepted: %+v %v", pair, err)
	}
	f.mu.Lock()
	order := strings.Join(f.order, ",")
	f.mu.Unlock()
	if order != "recovery" {
		t.Fatalf("candidate fetched after expiry: %s", order)
	}
	if err := verifyArtifact(filepath.Join(f.cache, f.descriptor.Recovery.SHA256+".apk"), f.descriptor.Recovery.SHA256, f.descriptor.Recovery.Length); err != nil {
		t.Fatalf("verified recovery bytes were discarded: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.cache, f.descriptor.Candidate.SHA256+".apk")); !os.IsNotExist(err) {
		t.Fatal("candidate unexpectedly staged")
	}
}

type timeReadFunc func() (*TrustedTimeInterval, error)

func (f timeReadFunc) ReadTime() (*TrustedTimeInterval, error) { return f() }

func TestSourceStagingRechecksAfterFinalIntegrity(t *testing.T) {
	f := stageFixture(t)
	if _, err := f.run(f.newStager(t)); err != nil {
		t.Fatal(err)
	}
	expires, _ := releaseTime(f.descriptor.Rollout.Expires)
	reads := 0
	// Cached artifacts require no TLS calls. The fifth source observation is
	// after both final full-file integrity checks, immediately before returning.
	source := timeReadFunc(func() (*TrustedTimeInterval, error) {
		reads++
		upper := now.UnixMilli() + 1000
		if reads >= 5 {
			upper = expires
		}
		return &TrustedTimeInterval{now.UnixMilli(), upper}, nil
	})
	if pair, err := stageWithSource(f, sourceStager(t, f, source)); err == nil || pair != nil || reads != 5 {
		t.Fatalf("final expiry accepted: reads=%d pair=%+v err=%v", reads, pair, err)
	}
}

func TestSourceStagingMissingClockRejects(t *testing.T) {
	f := stageFixture(t)
	source := stagingClock()
	source.set(1, 1, errors.New("time unavailable"))
	if pair, err := stageWithSource(f, sourceStager(t, f, source)); err == nil || pair != nil {
		t.Fatal("missing clock accepted")
	}
	s := f.newStager(t)
	s.source = nil
	if pair, err := stageWithSource(f, s); err == nil || pair != nil {
		t.Fatal("missing source silently supplied time")
	}
	if _, err := NewPreparedStagerWithTimeSource(f.enrollment, nil); err == nil {
		t.Fatal("nil source provisioned")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.order) != 0 {
		t.Fatal("rejected source reached network")
	}
}

func TestSourceStagingRegressedClockStopsTransfer(t *testing.T) {
	f := stageFixture(t)
	source := stagingClock()
	f.hook = func(name string) {
		if name == "recovery" {
			source.set(now.UnixMilli()-2000, now.UnixMilli()-1000, nil)
		}
	}
	if pair, err := stageWithSource(f, sourceStager(t, f, source)); err == nil || pair != nil {
		t.Fatal("regressed source accepted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.Join(f.order, ",") != "recovery" {
		t.Fatal(f.order)
	}
}
