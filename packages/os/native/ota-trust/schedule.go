package otatrust

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const dayMillis int64 = 24 * 60 * 60 * 1000
const leaseMillis int64 = 3 * 60 * 1000

// CheckDecision never authorizes installation. A nonempty token claims one
// metadata check; DelayMillis gives the next wakeup when no claim is granted.
type CheckDecision struct {
	Token       string
	DelayMillis int64
	Failures    int64
	Superseded  bool
}
type discoveryState struct {
	Version         int
	Seed            string
	Generation      int64
	Failures        int64
	Next            int64
	NotBefore       int64
	Lease           string
	LeaseGeneration int64
	LeaseUntil      int64
	LastTime        int64
}
type discoveryEnvelope struct {
	Data   json.RawMessage
	SHA256 string
}

// BeginDiscoveryInterval must receive qualified trusted time and the current durable
// channel generation. Use its own private directory, separate from TUF cache.
// Due times use the lower bound; delays and leases start from the upper bound.
func BeginDiscoveryInterval(directory string, lowerMillis, upperMillis, generation int64) (*CheckDecision, error) {
	return beginScheduledWork(directory, lowerMillis, upperMillis, generation, leaseMillis)
}

// BeginStagingInterval uses separate private schedule storage and a 35-minute lease,
// covering the artifact downloader's 30-minute limit plus local verification.
func BeginStagingInterval(directory string, lowerMillis, upperMillis, generation int64) (*CheckDecision, error) {
	return beginScheduledWork(directory, lowerMillis, upperMillis, generation, 35*60*1000)
}
func beginScheduledWork(directory string, lowerMillis, upperMillis, generation, leaseDuration int64) (decision *CheckDecision, err error) {
	if !validScheduleTime(lowerMillis) || !validScheduleTime(upperMillis) || upperMillis < lowerMillis || generation < 0 {
		return nil, errors.New("invalid discovery time/generation")
	}
	err = withDiscovery(directory, lowerMillis, upperMillis, func(s *discoveryState, nowMillis int64) error {
		if generation < s.Generation {
			return errors.New("stale discovery generation")
		}
		if generation != s.Generation {
			s.Generation = generation
			s.Next = nowMillis
		}
		if s.Lease != "" && nowMillis < s.LeaseUntil {
			decision = &CheckDecision{DelayMillis: s.LeaseUntil - nowMillis, Failures: s.Failures}
			return nil
		}
		if s.Lease != "" {
			s.Lease = ""
			s.LeaseUntil = 0
			s.Failures = min(s.Failures+1, 32)
			delay, e := failureDelay(s.Failures)
			if e != nil {
				return e
			}
			s.Next = upperMillis + delay
		}
		due := max(s.Next, s.NotBefore)
		if due > nowMillis {
			decision = &CheckDecision{DelayMillis: due - nowMillis, Failures: s.Failures}
			return nil
		}
		token, e := randomHex()
		if e != nil {
			return e
		}
		s.Lease = token
		s.LeaseGeneration = generation
		s.LeaseUntil = upperMillis + leaseDuration
		// Boot/network/channel triggers cannot create an unbounded request loop.
		s.NotBefore = max(s.NotBefore, upperMillis+30000)
		decision = &CheckDecision{Token: token, Failures: s.Failures}
		return nil
	})
	return decision, err
}

// FinishDiscoveryInterval records success/failure and server delay before the worker
// finishes. Old callbacks cannot change a newer claim. Channel changes retain
// global server/cooldown limits while discarding the old channel's schedule.
func FinishDiscoveryInterval(directory, token string, lowerMillis, upperMillis int64, success bool, retryAfterMillis int64) (*CheckDecision, error) {
	return finishScheduledWork(directory, token, lowerMillis, upperMillis, success, retryAfterMillis, false)
}

// FinishStagingInterval persists retry/server delay but adds no six-hour delay after a
// successful pair. Its separate directory prevents metadata success from hiding
// a failed/interrupted artifact transfer.
func FinishStagingInterval(directory, token string, lowerMillis, upperMillis int64, success bool, retryAfterMillis int64) (*CheckDecision, error) {
	return finishScheduledWork(directory, token, lowerMillis, upperMillis, success, retryAfterMillis, true)
}
func finishScheduledWork(directory, token string, lowerMillis, upperMillis int64, success bool, retryAfterMillis int64, staging bool) (decision *CheckDecision, err error) {
	if !validScheduleTime(lowerMillis) || !validScheduleTime(upperMillis) || upperMillis < lowerMillis || !validHex(token) || retryAfterMillis < 0 || retryAfterMillis > dayMillis {
		return nil, errors.New("invalid discovery result")
	}
	err = withDiscovery(directory, lowerMillis, upperMillis, func(s *discoveryState, nowMillis int64) error {
		if s.Lease != token || upperMillis >= s.LeaseUntil {
			return errors.New("stale discovery result")
		}
		s.NotBefore = max(s.NotBefore, upperMillis+retryAfterMillis)
		if s.Generation != s.LeaseGeneration {
			s.Next = nowMillis
		} else if success {
			s.Failures = 0
			seed, _ := hex.DecodeString(s.Seed)
			offset := int64(binary.BigEndian.Uint32(seed[:4]))
			s.Next = upperMillis + 6*60*60*1000 + (offset % 1800001) - 900000
			if staging {
				s.Next = nowMillis
			}
		} else {
			s.Failures = min(s.Failures+1, 32)
			delay, e := failureDelay(s.Failures)
			if e != nil {
				return e
			}
			s.Next = upperMillis + delay
		}
		s.Lease = ""
		s.LeaseUntil = 0
		decision = &CheckDecision{DelayMillis: max(0, max(s.Next, s.NotBefore)-nowMillis), Failures: s.Failures, Superseded: s.Generation != s.LeaseGeneration}
		return nil
	})
	return decision, err
}
func failureDelay(failures int64) (int64, error) {
	ceiling := int64(60000)
	for n := int64(1); n < failures && ceiling < dayMillis; n++ {
		ceiling = min(ceiling*2, dayMillis)
	}
	value, err := rand.Int(rand.Reader, big.NewInt(ceiling+1))
	if err != nil {
		return 0, err
	}
	return value.Int64(), nil
}
func randomHex() (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}
func validHex(s string) bool {
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == 32 && hex.EncodeToString(b) == s
}
func validScheduleTime(n int64) bool { return n > 0 && n < 1<<53-dayMillis-leaseMillis }
func withDiscovery(directory string, lower, upper int64, change func(*discoveryState, int64) error) error {
	stat, err := os.Lstat(directory)
	if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 || stat.Mode().Perm()&0077 != 0 {
		return errors.New("private discovery directory unavailable")
	}
	lock, err := os.OpenFile(filepath.Join(directory, ".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("discovery state busy")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "schedule_tmp") {
			info, e := entry.Info()
			if e != nil || !info.Mode().IsRegular() {
				return errors.New("unsafe abandoned schedule file")
			}
			if e = os.Remove(filepath.Join(directory, entry.Name())); e != nil {
				return e
			}
		}
	}
	state, err := readDiscovery(directory)
	if err != nil {
		return err
	}
	if upper < state.LastTime {
		return errors.New("discovery trusted time rollback")
	}
	state.LastTime = max(lower, state.LastTime)
	if err = change(state, state.LastTime); err != nil {
		return err
	}
	return saveDiscovery(directory, state, nil)
}
func readDiscovery(directory string) (*discoveryState, error) {
	name := filepath.Join(directory, "schedule.json")
	stat, err := os.Lstat(name)
	if os.IsNotExist(err) {
		seed, e := randomHex()
		if e != nil {
			return nil, e
		}
		return &discoveryState{Version: 1, Seed: seed}, nil
	}
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 16384 {
		return nil, errors.New("invalid discovery state file")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	if err = checkJSON(data); err != nil {
		return nil, err
	}
	var envelope discoveryEnvelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&envelope); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(envelope.Data)
	if envelope.SHA256 != hex.EncodeToString(digest[:]) {
		return nil, errors.New("discovery checksum mismatch")
	}
	var state discoveryState
	decoder = json.NewDecoder(bytes.NewReader(envelope.Data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&state); err != nil {
		return nil, err
	}
	if state.Version != 1 || !validHex(state.Seed) || state.Generation < 0 || state.LeaseGeneration < 0 || state.Failures < 0 || state.Failures > 32 || !validScheduleTime(state.LastTime) || state.Next < 0 || state.NotBefore < 0 || state.LeaseUntil < 0 || state.Next > 1<<53 || state.NotBefore > 1<<53 || state.LeaseUntil > 1<<53 || (state.Lease != "" && !validHex(state.Lease)) {
		return nil, errors.New("invalid discovery state")
	}
	return &state, nil
}
func saveDiscovery(directory string, state *discoveryState, fault func(string)) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	data, err = json.Marshal(discoveryEnvelope{Data: data, SHA256: hex.EncodeToString(digest[:])})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, "schedule_tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if fault != nil {
		fault("before-sync")
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if fault != nil {
		fault("before-rename")
	}
	if err = os.Rename(file.Name(), filepath.Join(directory, "schedule.json")); err != nil {
		return err
	}
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = errors.Join(dir.Sync(), dir.Close())
	if err != nil {
		return err
	}
	if fault != nil {
		fault("published")
	}
	return nil
}
