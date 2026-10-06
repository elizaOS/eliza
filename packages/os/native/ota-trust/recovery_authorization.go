package otatrust

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type preparedAuthorization struct {
	Version         int64             `json:"version"`
	Descriptor      releaseDescriptor `json:"descriptor"`
	Baseline        string            `json:"baseline"`
	BaselineVersion int64             `json:"baselineVersion"`
	Generation      int64             `json:"generation"`
	Hosts           []string          `json:"hosts"`
}

// RecoveryMaterial is only for the exact candidate/recovery identities already
// in the supervisor's committed journal. It never permits a fresh installation.
type RecoveryMaterial struct {
	Artifact        []byte
	ApprovedHosts   string
	Distribution    string
	CandidateSHA256 string
	RecoverySHA256  string
}

// Called only from authenticated discovery after persisted admission succeeds.
// Identity-addressed immutable records cannot overwrite an active recovery pair.
// The Android journal-coordinated store must prune unreferenced records before
// discovery. Preparation itself never deletes a record to make room.
func persistPreparedAuthorization(directory string, descriptor []byte, device admissionDevice, policy admissionPolicy, generation int64) (identity string, err error) {
	var d releaseDescriptor
	if err = decodeAdmission(descriptor, &d); err != nil {
		return "", err
	}
	if generation < 0 || generation > safeInteger {
		return "", errors.New("invalid authorization generation")
	}
	state := preparedAuthorization{Version: 1, Descriptor: d, Baseline: device.Installed, BaselineVersion: device.Version, Generation: generation, Hosts: policy.Hosts}
	identity, err = admissionHash(state)
	if err != nil {
		return "", err
	}
	err = lockedPrepared(directory, func() error {
		name := filepath.Join(directory, identity+".json")
		if _, e := os.Lstat(name); e == nil {
			_, e = readPrepared(directory, identity)
			return e
		} else if !os.IsNotExist(e) {
			return e
		}
		entries, e := os.ReadDir(directory)
		if e != nil {
			return e
		}
		count := 0
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				count++
			}
		}
		if count >= 32 {
			return errors.New("prepared authorization retention limit")
		}
		return writePrepared(directory, name, state, nil)
	})
	if err != nil {
		return "", err
	}
	return identity, nil
}

// LoadRecoveryAuthorization intentionally does not require fresh metadata or a
// clock: the previously authenticated authorization is narrow and candidate-bound.
// Current known revocations and lane/global security floors still apply. The
// caller must read identities from its committed journal and actual installed
// package, then perform signature/runtime checks and permit only one recovery.
func LoadRecoveryAuthorization(directory, admissionDirectory, identity, candidateDigest string, candidateVersion int64, recoveryDigest string, recoveryVersion int64, signer string, globalSecurityFloor int64) (material *RecoveryMaterial, err error) {
	if !validHex(candidateDigest) || !validHex(recoveryDigest) || !validHex(signer) || !bounded(globalSecurityFloor, 1, 2147483647) {
		return nil, errors.New("invalid recovery observations")
	}
	err = lockedPrepared(directory, func() error {
		record, e := readPrepared(directory, identity)
		if e != nil {
			return e
		}
		d := record.Descriptor
		if d.Candidate.SHA256 != candidateDigest || d.Candidate.VersionCode != candidateVersion || d.Recovery.SHA256 != recoveryDigest || d.Recovery.VersionCode != recoveryVersion || d.Recovery.Signer != signer {
			return errors.New("recovery authorization identity mismatch")
		}
		return lockedAdmission(admissionDirectory, func() error {
			state, e := readAdmission(admissionDirectory)
			if e != nil {
				return e
			}
			if state.Repository != d.Source.Repository || state.Distribution != d.Distribution {
				return errors.New("recovery enrollment mismatch")
			}
			floor, exists := state.Lanes[d.Channel]
			if !exists || floor.Sequence < d.Sequence || floor.Revision < d.Rollout.Revision {
				return errors.New("recovery authority state lost")
			}
			// Candidate revocation is precisely why local recovery can be needed. A
			// revoked recovery artifact itself is never an authorized escape route.
			if contains(floor.Revoked, d.Recovery.SHA256) || d.Recovery.SecurityEpoch < max(globalSecurityFloor, floor.Security) {
				return errors.New("recovery revoked or below security floor")
			}
			artifact, e := json.Marshal(d.Recovery)
			if e != nil {
				return e
			}
			material = &RecoveryMaterial{Artifact: artifact, ApprovedHosts: strings.Join(record.Hosts, ","), Distribution: d.Distribution, CandidateSHA256: d.Candidate.SHA256, RecoverySHA256: d.Recovery.SHA256}
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return material, nil
}
func readPrepared(directory, identity string) (*preparedAuthorization, error) {
	if !validHex(identity) {
		return nil, errors.New("invalid prepared authorization identity")
	}
	name := filepath.Join(directory, identity+".json")
	stat, err := os.Lstat(name)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxBytes {
		return nil, errors.New("prepared authorization missing or unsafe")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, err
	}
	var record preparedAuthorization
	if err = decodeAdmission(data, &record); err != nil {
		return nil, err
	}
	digest, err := admissionHash(record)
	if err != nil || digest != identity {
		return nil, errors.New("prepared authorization checksum mismatch")
	}
	if record.Version != 1 || !validHex(record.Baseline) || !bounded(record.BaselineVersion, 1, 2100000000) || !bounded(record.Generation, 0, safeInteger) || record.Descriptor.Candidate.VersionCode <= record.BaselineVersion || !contains(record.Descriptor.Candidate.Compatibility.Origins, record.Baseline) {
		return nil, errors.New("invalid prepared authorization binding")
	}
	if err = validateNativeRelease(record.Descriptor, record.Hosts); err != nil {
		return nil, err
	}
	return &record, nil
}
func lockedPrepared(directory string, operation func() error) error {
	stat, err := os.Lstat(directory)
	if err != nil || !stat.IsDir() || stat.Mode().Perm()&0077 != 0 || stat.Mode()&os.ModeSymlink != 0 {
		return errors.New("private authorization directory unavailable")
	}
	file, err := os.OpenFile(filepath.Join(directory, ".prepared.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err = file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return errors.New("unsafe authorization lock")
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("authorization state busy")
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return operation()
}
func writePrepared(directory, name string, record preparedAuthorization, fault func(string)) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return errors.New("prepared authorization too large")
	}
	temporary := filepath.Join(directory, "prepared.tmp")
	if stat, e := os.Lstat(temporary); e == nil {
		if !stat.Mode().IsRegular() {
			return errors.New("unsafe authorization temporary file")
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
	if err = os.Rename(temporary, name); err != nil {
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

// VerifyPreparedPair binds commit-time runtime expectations and journal scope to
// a previously persisted authenticated pair. Fresh policy and maintenance checks
// are additionally required by the caller; this function does not waive expiry.
func VerifyPreparedPair(directory, identity, baselineDigest string, baselineVersion, generation int64, channel, distribution string, candidateJSON, recoveryJSON []byte) error {
	return lockedPrepared(directory, func() error {
		record, err := readPrepared(directory, identity)
		if err != nil {
			return err
		}
		if record.Baseline != baselineDigest || record.BaselineVersion != baselineVersion || record.Generation != generation || record.Descriptor.Channel != channel || record.Descriptor.Distribution != distribution {
			return errors.New("prepared pair journal binding mismatch")
		}
		var candidate, recovery releaseArtifact
		if err = decodeAdmission(candidateJSON, &candidate); err != nil {
			return err
		}
		if err = decodeAdmission(recoveryJSON, &recovery); err != nil {
			return err
		}
		expectedCandidate, _ := admissionHash(record.Descriptor.Candidate)
		actualCandidate, _ := admissionHash(candidate)
		expectedRecovery, _ := admissionHash(record.Descriptor.Recovery)
		actualRecovery, _ := admissionHash(recovery)
		if expectedCandidate != actualCandidate || expectedRecovery != actualRecovery {
			return errors.New("prepared pair artifact expectations changed")
		}
		return nil
	})
}
