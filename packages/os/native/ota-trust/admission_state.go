package otatrust

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type admissionFloor struct {
	Sequence int64    `json:"sequence"`
	Revision int64    `json:"revision"`
	Security int64    `json:"security"`
	Core     string   `json:"core"`
	Rollout  string   `json:"rollout"`
	Revoked  []string `json:"revoked"`
}
type admissionState struct {
	Version      int64                     `json:"version"`
	Repository   string                    `json:"repository"`
	Distribution string                    `json:"distribution"`
	Lanes        map[string]admissionFloor `json:"lanes"`
}
type admissionEnvelope struct {
	State admissionState `json:"state"`
	Hash  string         `json:"hash"`
}

// InitializeAdmissionState is an explicit provisioning operation. It refuses
// existing state or other files; normal evaluation never initializes or resets
// missing/corrupt state. The directory must already be supervisor-private.
func InitializeAdmissionState(directory, repository, distribution string) error {
	if !matches(repository, repositoryPattern) || !contains([]string{"launcher", "standalone"}, distribution) {
		return errors.New("invalid admission enrollment")
	}
	return lockedAdmission(directory, func() error {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name() != ".admission.lock" {
				return errors.New("admission enrollment already has state")
			}
		}
		state := admissionState{Version: 1, Repository: repository, Distribution: distribution, Lanes: map[string]admissionFloor{}}
		return saveAdmission(directory, state, nil)
	})
}

// EvaluateRememberedReleaseInterval ratchets authenticated policy before returning any
// decision. The caller MUST authenticate descriptor bytes first. Floors are
// channel-scoped; choosing Beta cannot rewrite Stable authority. The provisioned
// installed/global security floor is also required in policyJSON. Quarantine and
// installed security state remain supervisor-owned and cannot be reset here.
func EvaluateRememberedReleaseInterval(directory string, descriptor, deviceJSON, policyJSON []byte) (*AdmissionResult, error) {
	var policy admissionPolicy
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	return evaluateRememberedRelease(directory, descriptor, deviceJSON, policy)
}

func evaluateRememberedRelease(directory string, descriptor, deviceJSON []byte, policy admissionPolicy) (result *AdmissionResult, err error) {
	err = lockedAdmission(directory, func() error {
		state, e := readAdmission(directory)
		if e != nil {
			return e
		}
		var d releaseDescriptor
		var device admissionDevice
		for _, input := range []struct {
			data  []byte
			value any
		}{{descriptor, &d}, {deviceJSON, &device}} {
			if e = decodeAdmission(input.data, input.value); e != nil {
				return e
			}
		}
		if policy.Repository != state.Repository || device.Distribution != state.Distribution {
			return errors.New("admission enrollment mismatch")
		}
		// Persisted floors must not hide invalid caller observations.
		if _, e = evaluateRelease(d, device, policy); e != nil {
			return e
		}
		floor := state.Lanes[device.Channel]
		policy.Sequence = max(policy.Sequence, floor.Sequence)
		policy.Revision = max(policy.Revision, floor.Revision)
		policy.SecurityFloor = max(policy.SecurityFloor, floor.Security)
		result, e = evaluateRelease(d, device, policy)
		if e != nil {
			return e
		}
		if d.Source.Repository != state.Repository || d.Channel != device.Channel || d.Distribution != state.Distribution {
			return nil
		}
		if d.Sequence < floor.Sequence || d.Rollout.Revision < floor.Revision || d.SecurityFloor < floor.Security {
			return nil
		}
		for _, digest := range floor.Revoked {
			if !contains(d.Rollout.Revoked, digest) {
				return errors.New("revocation regression")
			}
		}
		rollout := d.Rollout
		d.Rollout = releaseRollout{}
		coreHash, e := admissionHash(d)
		if e != nil {
			return e
		}
		rolloutHash, e := admissionHash(rollout)
		if e != nil {
			return e
		}
		if floor.Sequence == d.Sequence && floor.Core != coreHash {
			return errors.New("release sequence equivocation")
		}
		if floor.Sequence == d.Sequence && floor.Revision == rollout.Revision && floor.Rollout != rolloutHash {
			return errors.New("rollout revision equivocation")
		}
		state.Lanes[device.Channel] = admissionFloor{Sequence: d.Sequence, Revision: rollout.Revision, Security: d.SecurityFloor, Core: coreHash, Rollout: rolloutHash, Revoked: rollout.Revoked}
		return saveAdmission(directory, *state, nil)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
func admissionHash(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
func lockedAdmission(directory string, operation func() error) error {
	stat, err := os.Lstat(directory)
	if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 || stat.Mode().Perm()&0077 != 0 {
		return errors.New("private admission directory unavailable")
	}
	file, err := os.OpenFile(filepath.Join(directory, ".admission.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if stat, err = file.Stat(); err != nil || !stat.Mode().IsRegular() {
		return errors.New("unsafe admission lock")
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("admission state busy")
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return operation()
}
func readAdmission(directory string) (*admissionState, error) {
	name := filepath.Join(directory, "admission.json")
	stat, err := os.Lstat(name)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxBytes {
		return nil, errors.New("admission state missing or unsafe")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	var envelope admissionEnvelope
	if err = decodeAdmission(data, &envelope); err != nil {
		return nil, err
	}
	digest, err := admissionHash(envelope.State)
	if err != nil || digest != envelope.Hash {
		return nil, errors.New("admission state checksum mismatch")
	}
	s := envelope.State
	if s.Version != 1 || !matches(s.Repository, repositoryPattern) || !contains([]string{"launcher", "standalone"}, s.Distribution) || len(s.Lanes) > 2 {
		return nil, errors.New("invalid admission enrollment state")
	}
	for channel, floor := range s.Lanes {
		if !contains([]string{"stable", "beta"}, channel) || !bounded(floor.Sequence, 1, safeInteger) || !bounded(floor.Revision, 1, safeInteger) || !bounded(floor.Security, 1, 2147483647) || !validHex(floor.Core) || !validHex(floor.Rollout) || !stringList(floor.Revoked, 0, 4096, validHex) {
			return nil, errors.New("invalid remembered admission floor")
		}
	}
	return &s, nil
}
func saveAdmission(directory string, state admissionState, fault func(string)) error {
	hash, err := admissionHash(state)
	if err != nil {
		return err
	}
	data, err := json.Marshal(admissionEnvelope{State: state, Hash: hash})
	if err != nil {
		return err
	}
	temporary := filepath.Join(directory, "admission.tmp")
	if stat, e := os.Lstat(temporary); e == nil {
		if !stat.Mode().IsRegular() {
			return errors.New("unsafe admission temporary file")
		}
		if e = os.Remove(temporary); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	_, err = file.Write(data)
	if err != nil {
		file.Close()
		return err
	}
	if fault != nil {
		fault("before-sync")
	}
	err = errors.Join(file.Sync(), file.Close())
	if err != nil {
		return err
	}
	if fault != nil {
		fault("before-rename")
	}
	if err = os.Rename(temporary, filepath.Join(directory, "admission.json")); err != nil {
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
