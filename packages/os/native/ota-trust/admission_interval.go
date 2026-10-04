package otatrust

import (
	"encoding/json"
	"errors"
)

// This separate, strict JSON shape prevents legacy point-time consumers from
// silently treating an interval as exact time. No optional or default bounds.
type intervalAdmissionPolicy struct {
	Repository    string   `json:"repository"`
	Hosts         []string `json:"artifactHosts"`
	Lower         int64    `json:"trustedLowerMs"`
	Upper         int64    `json:"trustedUpperMs"`
	Sequence      int64    `json:"minimumSequence"`
	Revision      int64    `json:"minimumRolloutRevision"`
	SecurityFloor int64    `json:"securityFloor"`
}

func decodeIntervalPolicy(data []byte) ([]byte, int64, error) {
	var p intervalAdmissionPolicy
	if err := decodeAdmission(data, &p); err != nil {
		return nil, 0, err
	}
	if !bounded(p.Lower, 1, safeInteger) || !bounded(p.Upper, p.Lower, safeInteger) {
		return nil, 0, errors.New("invalid trusted time interval")
	}
	legacy, err := json.Marshal(admissionPolicy{
		Repository: p.Repository, Hosts: p.Hosts, Now: p.Lower,
		Sequence: p.Sequence, Revision: p.Revision, SecurityFloor: p.SecurityFloor,
	})
	return legacy, p.Upper, err
}

// EvaluateReleaseInterval admits only when the entire authenticated time
// interval lies within the rollout window. policyJSON requires trustedLowerMs
// and trustedUpperMs instead of trustedNowMs. The caller must authenticate the
// descriptor and establish current bounds; this API does neither and never
// authorizes installation. No midpoint is calculated or treated as exact time.
func EvaluateReleaseInterval(descriptor, deviceJSON, policyJSON []byte) (*AdmissionResult, error) {
	policy, upper, err := decodeIntervalPolicy(policyJSON)
	if err != nil {
		return nil, err
	}
	return evaluateRelease(descriptor, deviceJSON, policy, &upper)
}

// EvaluateRememberedReleaseInterval applies the same durable policy ratchets as
// EvaluateRememberedRelease while preserving both current-time bounds. Invalid
// intervals cannot mutate admission state. Valid authenticated policy can still
// advance revocations/floors when rollout-time defers installation.
func EvaluateRememberedReleaseInterval(directory string, descriptor, deviceJSON, policyJSON []byte) (*AdmissionResult, error) {
	policy, upper, err := decodeIntervalPolicy(policyJSON)
	if err != nil {
		return nil, err
	}
	return evaluateRememberedRelease(directory, descriptor, deviceJSON, policy, &upper)
}
