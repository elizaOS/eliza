package otatrust

import (
	"errors"
	"sync"
	"sync/atomic"
)

type discoveryTransport interface {
	Transport
	Close()
	RetryAfterMillis() int64
}

// discoverySession owns one attempt; Close cancels its transport.
// Inputs are provisioned native values, never renderer or downloaded settings.
// It authenticates metadata only; a result is not installation authorization.
type discoverySession struct {
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

func (s *discoverySession) Close() {
	s.closed.Store(true)
	s.transport.Close()
}

// Run reads fresh authenticated bounds from the bound native time source.
// Schedule persistence must succeed before any authenticated bytes are exposed.
// A caller must still recheck channel generation during admission and commit.
func (s *discoverySession) Run(scheduleDirectory, trustDirectory string, pinnedRoot []byte, metadataBase, channel, distribution string, generation int64) (*DiscoveryResult, error) {
	return s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, channel, distribution, generation, nil)
}
func (s *discoverySession) run(scheduleDirectory, trustDirectory string, pinnedRoot []byte, metadataBase, channel, distribution string, generation int64, admit func([]byte, *TrustedTimeInterval) (*AdmissionResult, error)) (*DiscoveryResult, error) {
	s.mu.Lock()
	if s.used || s.closed.Load() {
		s.mu.Unlock()
		return nil, errors.New("discovery session unavailable")
	}
	s.used = true
	s.mu.Unlock()
	defer s.transport.Close()
	initial, err := readTimeBounds(s.source)
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
	current, err := readTimeBounds(s.source)
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
	finalTime, err := readTimeBounds(s.source)
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
func (s *discoverySession) RunAdmitted(scheduleDirectory, trustDirectory, admissionDirectory string, pinnedRoot []byte, metadataBase string, deviceJSON, policyJSON []byte, generation int64) (*DiscoveryResult, error) {
	var device admissionDevice
	var policy admissionPolicy
	if err := decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	if err := validateAdmissionPolicy(policy); err != nil {
		return nil, err
	}
	if err := validateAdmissionDevice(device); err != nil {
		return nil, err
	}
	return s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, device.Channel, device.Distribution, generation, func(descriptor []byte, bounds *TrustedTimeInterval) (*AdmissionResult, error) {
		policy.Lower, policy.Upper = bounds.LowerMillis, bounds.UpperMillis
		return evaluateRememberedRelease(admissionDirectory, descriptor, deviceJSON, policy)
	})
}

// RunPrepared persists the exact candidate/recovery authorization before exposing
// an admitted result. Use AuthorizationID as the production journal plan ID.
// No record is created for deferred or already-installed outcomes.
func (s *discoverySession) RunPrepared(scheduleDirectory, trustDirectory, admissionDirectory, authorizationDirectory string, pinnedRoot []byte, metadataBase string, deviceJSON, policyJSON []byte, generation int64) (*DiscoveryResult, error) {
	var device admissionDevice
	var policy admissionPolicy
	if err := decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	if err := validateAdmissionPolicy(policy); err != nil {
		return nil, err
	}
	if err := validateAdmissionDevice(device); err != nil {
		return nil, err
	}
	identity := ""
	result, err := s.run(scheduleDirectory, trustDirectory, pinnedRoot, metadataBase, device.Channel, device.Distribution, generation, func(descriptor []byte, bounds *TrustedTimeInterval) (*AdmissionResult, error) {
		policy.Lower, policy.Upper = bounds.LowerMillis, bounds.UpperMillis
		decision, e := evaluateRememberedRelease(admissionDirectory, descriptor, deviceJSON, policy)
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

func narrowTimeFloor(bounds *TrustedTimeInterval, floor int64) error {
	if bounds.UpperMillis < floor {
		return errors.New("discovery time source regressed")
	}
	bounds.LowerMillis = max(bounds.LowerMillis, floor)
	return nil
}
