package otatrust

import (
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

type discoveryTransport interface {
	Transport
	Close()
	RetryAfterMillis() int64
}

// DiscoverySession is single-use. Android must Close it on job cancellation.
// Inputs are provisioned native values, never renderer or downloaded settings.
// It authenticates metadata only; a result is not installation authorization.
type DiscoverySession struct {
	mu        sync.Mutex
	transport discoveryTransport
	source    TrustedTimeSource
	used      bool
	closed    atomic.Bool
}

type DiscoveryResult struct {
	Status          string
	Descriptor      []byte
	DelayMillis     int64
	Generation      int64
	Admission       *AdmissionResult
	AuthorizationID string
}

func NewDiscoverySession(approvedHosts string) (*DiscoverySession, error) {
	t, err := NewHTTPTransport(approvedHosts)
	if err != nil {
		return nil, err
	}
	return &DiscoverySession{transport: t}, nil
}

func (s *DiscoverySession) Close() {
	s.closed.Store(true)
	s.transport.Close()
}

// Run uses qualified trusted time at entry and monotonic elapsed time at finish.
// Schedule persistence must succeed before any authenticated bytes are exposed.
// A caller must still recheck channel generation during admission and commit.
func (s *DiscoverySession) Run(scheduleDirectory, trustDirectory string, pinnedRoot []byte, metadataBase, channel, distribution string, trustedUnixMillis, generation int64) (*DiscoveryResult, error) {
	return s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, channel, distribution, trustedUnixMillis, generation, nil)
}
func (s *DiscoverySession) run(scheduleDirectory, trustDirectory string, pinnedRoot []byte, metadataBase, channel, distribution string, trustedUnixMillis, generation int64, admit func([]byte, *TrustedTimeInterval) (*AdmissionResult, error)) (*DiscoveryResult, error) {
	s.mu.Lock()
	if s.used || s.closed.Load() {
		s.mu.Unlock()
		return nil, errors.New("discovery session unavailable")
	}
	s.used = true
	s.mu.Unlock()
	defer s.transport.Close()
	started := time.Now()
	initial, err := s.currentTime(trustedUnixMillis)
	if err != nil {
		return nil, err
	}
	claim, err := BeginDiscoveryInterval(scheduleDirectory, initial.LowerMillis, initial.UpperMillis, generation)
	if err != nil {
		return nil, err
	}
	result := &DiscoveryResult{Status: "deferred", DelayMillis: claim.DelayMillis, Generation: generation}
	if claim.Token == "" {
		return result, nil
	}
	descriptor, fetchErr := FetchDescriptorInterval(trustDirectory, pinnedRoot, metadataBase, channel, distribution, initial.LowerMillis, initial.UpperMillis, s.transport)
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.currentTime(trustedUnixMillis + time.Since(started).Milliseconds())
	if err != nil {
		return nil, err
	} // Retain claim for bounded crash-style recovery.
	if err = narrowTimeFloor(current, initial.LowerMillis); err != nil {
		return nil, err
	}
	var admission *AdmissionResult
	var admissionErr error
	if fetchErr == nil && !s.closed.Load() && admit != nil {
		admission, admissionErr = admit(descriptor, current)
	}
	success := fetchErr == nil && admissionErr == nil && !s.closed.Load()
	finalTime, err := s.currentTime(trustedUnixMillis + time.Since(started).Milliseconds())
	if err != nil {
		return nil, err
	}
	if err = narrowTimeFloor(finalTime, current.LowerMillis); err != nil {
		return nil, err
	}
	finished, err := FinishDiscoveryInterval(scheduleDirectory, claim.Token, finalTime.LowerMillis, finalTime.UpperMillis, success, s.transport.RetryAfterMillis())
	if err != nil {
		return nil, err
	}
	if admissionErr != nil {
		return nil, admissionErr
	}
	result.DelayMillis = finished.DelayMillis
	if success && !finished.Superseded {
		result.Status = "authenticated"
		result.Descriptor = descriptor
		result.Admission = admission
		if admission != nil {
			result.Status = "deferred"
			if admission.Decision == "eligible" {
				result.Status = "admitted"
			} else {
				result.Descriptor = nil
				if admission.Decision == "already-installed" {
					result.Status = "already-installed"
				}
			}
		}
	}
	return result, nil
}

// RunAdmitted composes TUF authentication, persisted anti-replay admission and
// scheduling. Only an admitted result exposes descriptor bytes for downloading.
// policyJSON's time must come from the qualified native clock. Device fields
// must come from current supervisor observations, not renderer-provided JSON.
func (s *DiscoverySession) RunAdmitted(scheduleDirectory, trustDirectory, admissionDirectory string, pinnedRoot []byte, metadataBase string, deviceJSON, policyJSON []byte, generation int64) (*DiscoveryResult, error) {
	var device admissionDevice
	var policy admissionPolicy
	if err := decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	return s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, device.Channel, device.Distribution, policy.Now, generation, func(descriptor []byte, bounds *TrustedTimeInterval) (*AdmissionResult, error) {
		policy.Now = bounds.LowerMillis
		updated, err := json.Marshal(policy)
		if err != nil {
			return nil, err
		}
		return evaluateRememberedRelease(admissionDirectory, descriptor, deviceJSON, updated, &bounds.UpperMillis)
	})
}

// RunPrepared persists the exact candidate/recovery authorization before exposing
// an admitted result. Use AuthorizationID as the production journal plan ID.
// No record is created for deferred or already-installed outcomes.
func (s *DiscoverySession) RunPrepared(scheduleDirectory, trustDirectory, admissionDirectory, authorizationDirectory string, pinnedRoot []byte, metadataBase string, deviceJSON, policyJSON []byte, generation int64) (*DiscoveryResult, error) {
	var device admissionDevice
	var policy admissionPolicy
	if err := decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	identity := ""
	result, err := s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, device.Channel, device.Distribution, policy.Now, generation, func(descriptor []byte, bounds *TrustedTimeInterval) (*AdmissionResult, error) {
		policy.Now = bounds.LowerMillis
		updated, e := json.Marshal(policy)
		if e != nil {
			return nil, e
		}
		decision, e := evaluateRememberedRelease(admissionDirectory, descriptor, deviceJSON, updated, &bounds.UpperMillis)
		if e != nil {
			return nil, e
		}
		if decision.Decision == "eligible" {
			identity, e = persistPreparedAuthorization(authorizationDirectory, descriptor, device, policy, generation)
			if e != nil {
				return nil, e
			}
		}
		return decision, nil
	})
	if err != nil {
		return nil, err
	}
	if result.Status == "admitted" {
		result.AuthorizationID = identity
	}
	return result, nil
}

// Only the legacy exact-time path projects a point using Go elapsed time. The
// provider path obtains fresh native, suspend-inclusive bounds at every stage.
func (s *DiscoverySession) currentTime(fallback int64) (*TrustedTimeInterval, error) {
	if s.source != nil {
		return readTimeBounds(s.source)
	}
	if !validScheduleTime(fallback) {
		return nil, errors.New("invalid discovery time")
	}
	return &TrustedTimeInterval{LowerMillis: fallback, UpperMillis: fallback}, nil
}
func narrowTimeFloor(bounds *TrustedTimeInterval, floor int64) error {
	if bounds.UpperMillis < floor {
		return errors.New("discovery time source regressed")
	}
	bounds.LowerMillis = max(bounds.LowerMillis, floor)
	return nil
}
