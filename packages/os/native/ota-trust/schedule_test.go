package otatrust

import (
	"encoding/binary"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const scheduleNow int64 = 1790899200000

func claim(t *testing.T, dir string, now, generation int64) *CheckDecision {
	t.Helper()
	d, err := BeginDiscoveryInterval(dir, now, now, generation)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func TestDiscoveryRetrySurvivesRestartAndChannelChange(t *testing.T) {
	dir := privateDir(t)
	first := claim(t, dir, scheduleNow, 0)
	if first.Token == "" {
		t.Fatal("first check not claimed")
	}
	busy := claim(t, dir, scheduleNow+1, 0)
	if busy.Token != "" || busy.DelayMillis <= 0 {
		t.Fatal("duplicate check admitted")
	}
	done, err := FinishDiscoveryInterval(dir, first.Token, scheduleNow+1000, scheduleNow+1000, false, 120000)
	if err != nil || done.DelayMillis < 120000 || done.Failures != 1 {
		t.Fatal("retry not stored", done, err)
	}
	restarted := claim(t, dir, scheduleNow+2000, 1)
	if restarted.Token != "" || restarted.DelayMillis < 119000 {
		t.Fatal("channel change bypassed server delay")
	}
	if _, err = FinishDiscoveryInterval(dir, first.Token, scheduleNow+2000, scheduleNow+2000, true, 0); err == nil {
		t.Fatal("duplicate result accepted")
	}
	next := claim(t, dir, scheduleNow+122000, 1)
	if next.Token == "" || next.Token == first.Token {
		t.Fatal("retry not admitted after delay")
	}
	if _, err = BeginDiscoveryInterval(dir, scheduleNow+122001, scheduleNow+122001, 0); err == nil {
		t.Fatal("old channel generation admitted")
	}
}
func TestDiscoveryChannelChangeDuringCheck(t *testing.T) {
	dir := privateDir(t)
	first := claim(t, dir, scheduleNow, 0)
	changed := claim(t, dir, scheduleNow+1, 1)
	if changed.Token != "" {
		t.Fatal("parallel channel check admitted")
	}
	done, err := FinishDiscoveryInterval(dir, first.Token, scheduleNow+1000, scheduleNow+1000, true, 0)
	if err != nil || done.DelayMillis > 30000 {
		t.Fatal("old channel success suppressed fresh channel check", done, err)
	}
	if claim(t, dir, scheduleNow+30001, 1).Token == "" {
		t.Fatal("fresh channel deferred")
	}
}
func TestDiscoveryAbandonedLeaseAndLateResult(t *testing.T) {
	dir := privateDir(t)
	first := claim(t, dir, scheduleNow, 0)
	if _, err := FinishDiscoveryInterval(dir, first.Token, scheduleNow+leaseMillis, scheduleNow+leaseMillis, true, 0); err == nil {
		t.Fatal("expired claim completed")
	}
	after := claim(t, dir, scheduleNow+leaseMillis, 0)
	if after.Failures != 1 || after.DelayMillis > 60000 {
		t.Fatal("abandoned check not backed off")
	}
	if _, err := FinishDiscoveryInterval(dir, first.Token, scheduleNow+leaseMillis+1, scheduleNow+leaseMillis+1, true, 0); err == nil {
		t.Fatal("stale result accepted after abandonment")
	}
}
func TestDiscoveryJitterUsesWholeWindow(t *testing.T) {
	for _, offset := range []uint32{0, 1800000} {
		dir := privateDir(t)
		first := claim(t, dir, scheduleNow, 0)
		state, err := readDiscovery(dir)
		if err != nil {
			t.Fatal(err)
		}
		seed := make([]byte, 32)
		binary.BigEndian.PutUint32(seed, offset)
		state.Seed = hex.EncodeToString(seed)
		if err = saveDiscovery(dir, state, nil); err != nil {
			t.Fatal(err)
		}
		done, err := FinishDiscoveryInterval(dir, first.Token, scheduleNow+1, scheduleNow+1, true, 0)
		want := int64(6*60*60*1000) + int64(offset) - 900000
		if err != nil || done.DelayMillis != want {
			t.Fatal("wrong normal check jitter", done, want, err)
		}
	}
}
func TestDiscoveryCorruptionAndClockRollback(t *testing.T) {
	dir := privateDir(t)
	claim(t, dir, scheduleNow, 0)
	if _, err := BeginDiscoveryInterval(dir, scheduleNow-1, scheduleNow-1, 0); err == nil {
		t.Fatal("clock rollback admitted")
	}
	file := filepath.Join(dir, "schedule.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(string(data), `"Generation":0`, `"Generation":9`, 1)
	if changed == string(data) {
		t.Fatal("test mutation missing")
	}
	os.WriteFile(file, []byte(changed), 0600)
	if _, err = BeginDiscoveryInterval(dir, scheduleNow+1, scheduleNow+1, 0); err == nil {
		t.Fatal("corrupt state reset")
	}
}
func TestDiscoveryConcurrentClaims(t *testing.T) {
	dir := privateDir(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims := 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			decision, err := BeginDiscoveryInterval(dir, scheduleNow, scheduleNow, 0)
			if err == nil && decision.Token != "" {
				mu.Lock()
				claims++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claims != 1 {
		t.Fatalf("got %d concurrent claims", claims)
	}
}
func TestDiscoveryKilledWriter(t *testing.T) {
	if directory := os.Getenv("OTA_DISCOVERY_KILL_DIR"); directory != "" {
		state, err := readDiscovery(directory)
		if err != nil {
			t.Fatal(err)
		}
		state.Generation = 1
		if err = saveDiscovery(directory, state, func(point string) {
			if point == os.Getenv("OTA_DISCOVERY_KILL_POINT") {
				os.Exit(24)
			}
		}); err != nil {
			t.Fatal(err)
		}
		t.Fatal("fault not reached")
	}
	for _, point := range []string{"before-sync", "before-rename", "published"} {
		t.Run(point, func(t *testing.T) {
			dir := privateDir(t)
			claim(t, dir, scheduleNow, 0)
			child := exec.Command(os.Args[0], "-test.run=^TestDiscoveryKilledWriter$")
			child.Env = append(os.Environ(), "OTA_DISCOVERY_KILL_DIR="+dir, "OTA_DISCOVERY_KILL_POINT="+point)
			err := child.Run()
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 24 {
				t.Fatal("child did not terminate at boundary", err)
			}
			state, err := readDiscovery(dir)
			if err != nil {
				t.Fatal(err)
			}
			want := int64(0)
			if point == "published" {
				want = 1
			}
			if state.Generation != want {
				t.Fatal("publication state wrong")
			}
		})
	}
}

func TestDiscoveryBackoffCapsAndSuccessResets(t *testing.T) {
	dir := privateDir(t)
	now := scheduleNow
	for attempt := int64(1); attempt <= 34; attempt++ {
		begin := claim(t, dir, now, 0)
		if begin.Token == "" {
			t.Fatal("scheduled attempt not granted")
		}
		done, err := FinishDiscoveryInterval(dir, begin.Token, now+1, now+1, false, 0)
		if err != nil || done.DelayMillis > dayMillis || done.Failures != min(attempt, 32) {
			t.Fatal("unbounded backoff", done, err)
		}
		now += done.DelayMillis + 2
	}
	begin := claim(t, dir, now, 0)
	done, err := FinishDiscoveryInterval(dir, begin.Token, now+1, now+1, true, 0)
	if err != nil || done.Failures != 0 {
		t.Fatal("success did not reset failures")
	}
}

func TestStagingLeaseCoversLongTransfersWithoutMetadataDelay(t *testing.T) {
	dir := privateDir(t)
	first, e := BeginStagingInterval(dir, scheduleNow, scheduleNow, 0)
	if e != nil || first.Token == "" {
		t.Fatal(e)
	}
	busy, e := BeginStagingInterval(dir, scheduleNow+4*60*1000, scheduleNow+4*60*1000, 0)
	if e != nil || busy.Token != "" || busy.DelayMillis < 30*60*1000 {
		t.Fatal("short staging lease", busy, e)
	}
	done, e := FinishStagingInterval(dir, first.Token, scheduleNow+30*60*1000, scheduleNow+30*60*1000, true, 0)
	if e != nil || done.DelayMillis != 0 {
		t.Fatal("staging inherited metadata delay", done, e)
	}
	next, e := BeginStagingInterval(dir, scheduleNow+30*60*1000+1, scheduleNow+30*60*1000+1, 0)
	if e != nil || next.Token == "" {
		t.Fatal("new pair was blocked", e)
	}
}
func TestStagingPersistsBackoffAcrossChannelAndProcessLoss(t *testing.T) {
	dir := privateDir(t)
	first, e := BeginStagingInterval(dir, scheduleNow, scheduleNow, 0)
	if e != nil {
		t.Fatal(e)
	}
	done, e := FinishStagingInterval(dir, first.Token, scheduleNow+1000, scheduleNow+1000, false, 120000)
	if e != nil || done.DelayMillis < 120000 || done.Failures != 1 {
		t.Fatal(done, e)
	}
	changed, e := BeginStagingInterval(dir, scheduleNow+2000, scheduleNow+2000, 1)
	if e != nil || changed.Token != "" || changed.DelayMillis < 119000 {
		t.Fatal("channel bypassed server delay", changed, e)
	}
	resumed, e := BeginStagingInterval(dir, scheduleNow+122000, scheduleNow+122000, 1)
	if e != nil || resumed.Token == "" {
		t.Fatal(e)
	}
	// Abandoned process cannot leave a permanent active claim; recovery applies
	// exponential backoff after its longer staging lease expires.
	recovered, e := BeginStagingInterval(dir, scheduleNow+122000+36*60*1000, scheduleNow+122000+36*60*1000, 1)
	if e != nil || recovered.Failures != 2 {
		t.Fatal(recovered, e)
	}
	if _, e = FinishStagingInterval(dir, resumed.Token, scheduleNow+122000+36*60*1000, scheduleNow+122000+36*60*1000, true, 0); e == nil {
		t.Fatal("late abandoned completion accepted")
	}
}
