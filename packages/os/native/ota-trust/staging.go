package otatrust

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
)

// PreparedStager downloads one authenticated pair, recovery first. Its private
// cache is not an install queue; Android must still verify APK signatures/runtime
// and perform fresh admission, maintenance and journal checks before commit.
type PreparedStager struct {
	downloader          *ArtifactDownloader
	source              TrustedTimeSource
	enrollmentDirectory string
	enrollmentID        string
	enrollment          *Enrollment
	config              enrollmentConfig
	mu                  sync.Mutex
	used                bool
	closed              atomic.Bool
}
type StagedPair struct {
	AuthorizationID string
	CandidatePath   string
	RecoveryPath    string
	Descriptor      []byte
	Generation      int64
}

// NewPreparedStagerWithTimeSource shares one qualified source with HTTPS and
// fresh admission before/between/after transfers and final integrity checks.
func NewPreparedStagerWithTimeSource(directory string, source TrustedTimeSource) (*PreparedStager, error) {
	if _, err := readTimeBounds(source); err != nil {
		return nil, err
	}
	s, err := newPreparedStager(directory, func(hosts string) (*ArtifactDownloader, error) {
		return NewArtifactDownloaderWithTimeSource(hosts, source)
	})
	if err != nil {
		return nil, err
	}
	s.source = source
	return s, nil
}
func newPreparedStager(directory string, newDownloader func(string) (*ArtifactDownloader, error)) (*PreparedStager, error) {
	enrollment, err := ReadEnrollment(directory)
	if err != nil {
		return nil, err
	}
	var config enrollmentConfig
	if err = decodeAdmission(enrollment.Config, &config); err != nil {
		return nil, err
	}
	identity, err := admissionHash(enrollment)
	if err != nil {
		return nil, err
	}
	downloader, err := newDownloader(strings.Join(config.Hosts, ","))
	if err != nil {
		return nil, err
	}
	return &PreparedStager{downloader: downloader, enrollmentDirectory: directory, enrollmentID: identity, enrollment: enrollment, config: config}, nil
}
func (s *PreparedStager) Close()                  { s.closed.Store(true); s.downloader.Close() }
func (s *PreparedStager) RetryAfterMillis() int64 { return s.downloader.RetryAfterMillis() }
func (s *PreparedStager) validate(directory, admissionDirectory, identity string, deviceJSON []byte, bounds *TrustedTimeInterval, floor, generation int64) (*preparedAuthorization, error) {
	if s.closed.Load() {
		return nil, errors.New("staging cancelled")
	}
	enrollment, err := ReadEnrollment(s.enrollmentDirectory)
	if err != nil {
		return nil, err
	}
	hash, err := admissionHash(enrollment)
	if err != nil || hash != s.enrollmentID {
		return nil, errors.New("staging enrollment changed")
	}
	var device admissionDevice
	if err = decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err = validateAdmissionDevice(device); err != nil {
		return nil, err
	}
	if device.Signer != s.config.Signer || device.Distribution != s.config.Distribution || device.CohortID != s.enrollment.CohortID {
		return nil, errors.New("staging device enrollment mismatch")
	}
	var record *preparedAuthorization
	if err = lockedPrepared(directory, func() error { var e error; record, e = readPrepared(directory, identity); return e }); err != nil {
		return nil, err
	}
	if record.Generation != generation || record.Baseline != device.Installed || record.BaselineVersion != device.Version || record.Descriptor.Channel != device.Channel || !reflect.DeepEqual(record.Hosts, s.config.Hosts) {
		return nil, errors.New("stale prepared staging decision")
	}
	policy := admissionPolicy{Repository: s.config.Repository, Hosts: s.config.Hosts, Lower: bounds.LowerMillis, Upper: bounds.UpperMillis, Sequence: 1, Revision: 1, SecurityFloor: floor}
	descriptor, err := json.Marshal(record.Descriptor)
	if err != nil {
		return nil, err
	}
	decision, err := evaluateRememberedRelease(admissionDirectory, descriptor, deviceJSON, policy)
	if err != nil {
		return nil, err
	}
	if decision.Decision != "eligible" {
		return nil, errors.New("prepared release is no longer eligible: " + decision.Reason)
	}
	return record, nil
}

// StageWithTimeSource accepts no point-time override. Qualified source failure
// prevents returning a pair, even when artifact bytes already exist in cache.
func (s *PreparedStager) StageWithTimeSource(authorizationDirectory, admissionDirectory, cacheDirectory, identity string, deviceJSON []byte, securityFloor, generation, reserveBytes int64) (*StagedPair, error) {
	bounds, err := readTimeBounds(s.source)
	if err != nil {
		s.Close()
		return nil, err
	}
	s.mu.Lock()
	if s.used || s.closed.Load() {
		s.mu.Unlock()
		return nil, errors.New("staging session unavailable")
	}
	s.used = true
	s.mu.Unlock()
	defer s.Close()
	if !bounded(securityFloor, 1, safeInteger) || generation < 0 || reserveBytes < 0 || reserveBytes > safeInteger {
		return nil, errors.New("invalid staging observations")
	}
	lastLower := bounds.LowerMillis
	validateCurrent := func() (*preparedAuthorization, error) {
		bounds, err := readTimeBounds(s.source)
		if err != nil {
			return nil, err
		}
		if err := narrowTimeFloor(bounds, lastLower); err != nil {
			return nil, err
		}
		lastLower = bounds.LowerMillis
		return s.validate(authorizationDirectory, admissionDirectory, identity, deviceJSON, bounds, securityFloor, generation)
	}
	record, err := validateCurrent()
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(cacheDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private pair cache unavailable")
	}
	lock, err := os.OpenFile(filepath.Join(cacheDirectory, ".pair.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	info, err = lock.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("unsafe pair lock")
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("another pair is staging")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	candidate, recovery := record.Descriptor.Candidate, record.Descriptor.Recovery
	// Reserve space for the candidate while obtaining recovery first. A verified
	// cached candidate already occupies its bytes and needs no second reservation.
	candidateNeed := candidate.Length
	if verifyArtifact(filepath.Join(cacheDirectory, candidate.SHA256+".apk"), candidate.SHA256, candidate.Length) == nil {
		candidateNeed = 0
	}
	if reserveBytes > safeInteger-candidateNeed {
		return nil, errors.New("pair storage budget overflow")
	}
	recoveryPath, err := s.download(cacheDirectory, recovery, reserveBytes+candidateNeed)
	if err != nil {
		return nil, err
	}
	if _, err = validateCurrent(); err != nil {
		return nil, err
	}
	candidatePath, err := s.download(cacheDirectory, candidate, reserveBytes)
	if err != nil {
		return nil, err
	}
	if _, err = validateCurrent(); err != nil {
		return nil, err
	}
	if err = verifyArtifact(recoveryPath, recovery.SHA256, recovery.Length); err != nil {
		return nil, err
	}
	if err = verifyArtifact(candidatePath, candidate.SHA256, candidate.Length); err != nil {
		return nil, err
	}
	available, err := artifactFreeSpace(cacheDirectory)
	if err != nil {
		return nil, err
	}
	if available < reserveBytes {
		return nil, errors.New("pair staging consumed required reserve")
	}
	if s.closed.Load() {
		return nil, errors.New("pair staging cancelled")
	}
	if _, err = validateCurrent(); err != nil {
		return nil, err
	}
	descriptor, err := json.Marshal(record.Descriptor)
	if err != nil {
		return nil, err
	}
	return &StagedPair{AuthorizationID: identity, CandidatePath: candidatePath, RecoveryPath: recoveryPath, Descriptor: descriptor, Generation: generation}, nil
}

func (s *PreparedStager) download(directory string, artifact releaseArtifact, reserve int64) (string, error) {
	var last error
	for _, address := range append([]string{artifact.URL}, artifact.Mirrors...) {
		result, err := s.downloader.Download(directory, address, artifact.SHA256, artifact.Length, reserve)
		if err == nil {
			return result, nil
		}
		last = err
		if s.closed.Load() || s.downloader.RetryAfterMillis() > 0 {
			return "", err
		}
	}
	return "", last
}
