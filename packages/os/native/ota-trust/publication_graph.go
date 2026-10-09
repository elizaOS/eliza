package otatrust

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/trustedmetadata"
	"strings"
	"time"
	"unicode/utf8"
)

type publicationBundle struct {
	Files map[string][]byte `json:"files"`
}
type publicationPolicy struct {
	Upper   int64            `json:"trustedUpperMs"`
	Minimum map[string]int64 `json:"minimumVersions"`
}

// VerifyPublicationGraph validates an offline complete signed metadata closure.
// The caller supplies provisioned root bytes, qualified time and durable role
// floors. It neither acquires that authority nor persists advancement. Artifact
// preflight, provenance approvals and publication CAS remain separate gates.
func VerifyPublicationGraph(root, bundleJSON, policyJSON []byte) ([]byte, error) {
	var bundle publicationBundle
	var policy publicationPolicy
	if len(bundleJSON) > 96*1024*1024 || !utf8.Valid(bundleJSON) {
		return nil, errors.New("publication bundle exceeds budget")
	}
	if err := decodeAdmission(policyJSON, &policy); err != nil {
		return nil, err
	}
	if !bounded(policy.Upper, 1, safeInteger) || len(policy.Minimum) != 6 {
		return nil, errors.New("complete publication time/version policy required")
	}
	for _, role := range []string{"root", "timestamp", "snapshot", "targets", "stable", "beta"} {
		v, ok := policy.Minimum[role]
		if !ok || !bounded(v, 1, safeInteger) {
			return nil, errors.New("invalid publication role floor")
		}
	}
	if err := checkJSON(bundleJSON); err != nil {
		return nil, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(bundleJSON, &envelope); err != nil {
		return nil, err
	}
	if len(envelope) != 1 || envelope["files"] == nil {
		return nil, errors.New("publication envelope fields")
	}
	if err := json.Unmarshal(envelope["files"], &bundle.Files); err != nil {
		return nil, err
	}
	if len(bundle.Files) < 5 || len(bundle.Files) > 128 {
		return nil, errors.New("publication file count")
	}
	total := 0
	for _, data := range bundle.Files {
		total += len(data)
		if len(data) == 0 || int64(len(data)) > maxBytes || total > 64*1024*1024 {
			return nil, errors.New("publication file budget")
		}
		if err := checkJSON(data); err != nil {
			return nil, err
		}
	}
	if len(root) == 0 || int64(len(root)) > maxBytes {
		return nil, errors.New("root budget")
	}
	if err := checkJSON(root); err != nil {
		return nil, err
	}
	trusted, err := trustedmetadata.New(root)
	if err != nil {
		return nil, err
	}
	trusted.RefTime = time.UnixMilli(policy.Upper).Add(time.Nanosecond)
	used := map[string]bool{}
	get := func(name string) ([]byte, error) {
		data, ok := bundle.Files[name]
		if !ok {
			return nil, fmt.Errorf("publication dependency missing: %s", name)
		}
		used[name] = true
		return data, nil
	}
	for i := 0; i < 32; i++ {
		name := fmt.Sprintf("%d.root.json", trusted.Root.Signed.Version+1)
		data, ok := bundle.Files[name]
		if !ok {
			break
		}
		used[name] = true
		if _, err = trusted.UpdateRoot(data); err != nil {
			return nil, err
		}
	}
	if !trusted.Root.Signed.ConsistentSnapshot {
		return nil, errors.New("publication requires consistent snapshots")
	}
	timestamp, err := get("timestamp.json")
	if err != nil {
		return nil, err
	}
	if len(timestamp) > 16384 {
		return nil, errors.New("timestamp budget")
	}
	if _, err = trusted.UpdateTimestamp(timestamp); err != nil {
		return nil, err
	}
	ref := trusted.Timestamp.Signed.Meta["snapshot.json"]
	if len(trusted.Timestamp.Signed.Meta) != 1 || !strongPublicationReference(ref) {
		return nil, errors.New("timestamp must bind exact snapshot bytes")
	}
	data, err := get(fmt.Sprintf("%d.snapshot.json", ref.Version))
	if err != nil {
		return nil, err
	}
	if _, err = trusted.UpdateSnapshot(data, false); err != nil {
		return nil, err
	}
	if len(trusted.Snapshot.Signed.Meta) != 3 {
		return nil, errors.New("snapshot must contain complete channel graph")
	}
	for _, role := range []string{"targets", "stable", "beta"} {
		ref = trusted.Snapshot.Signed.Meta[role+".json"]
		if !strongPublicationReference(ref) {
			return nil, errors.New("snapshot must bind exact role bytes")
		}
		data, err = get(fmt.Sprintf("%d.%s.json", ref.Version, role))
		if err != nil {
			return nil, err
		}
		if role == "targets" {
			_, err = trusted.UpdateTargets(data)
		} else {
			_, err = trusted.UpdateDelegatedTargets(data, role, "targets")
		}
		if err != nil {
			return nil, err
		}
		if role == "targets" {
			if err = validateChannelRoles(trusted.Root, trusted.Targets[role]); err != nil {
				return nil, err
			}
		}
	}
	versions := map[string]int64{"root": trusted.Root.Signed.Version, "timestamp": trusted.Timestamp.Signed.Version, "snapshot": trusted.Snapshot.Signed.Version}
	descriptors := map[string]json.RawMessage{}
	for _, role := range []string{"targets", "stable", "beta"} {
		targets := trusted.Targets[role]
		versions[role] = targets.Signed.Version
		if role == "targets" {
			continue
		}
		// A channel may have no release yet; an empty role must still be signed,
		// snapshot-bound and have no nested delegation.
		if len(targets.Signed.Targets) == 0 {
			if targets.Signed.Delegations != nil {
				return nil, errors.New("empty channel redelegates")
			}
			continue
		}
		if err = validateChannelTargets(role, targets); err != nil {
			return nil, err
		}
		for target, info := range targets.Signed.Targets {
			sha, ok := info.Hashes["sha256"]
			if !ok || len(sha) != 32 || info.Length < 1 || info.Length > maxBytes {
				return nil, errors.New("descriptor requires bounded SHA256 identity")
			}
			pieces := strings.Split(target, "/")
			name := "targets/" + pieces[0] + "/" + hex.EncodeToString(sha) + "." + pieces[1]
			data, err = get(name)
			if err != nil {
				return nil, err
			}
			if err = info.VerifyLengthHashes(data); err != nil {
				return nil, err
			}
			descriptors[target] = json.RawMessage(data)
		}
	}
	for role, v := range versions {
		if !bounded(v, 1, safeInteger) || v < policy.Minimum[role] {
			return nil, fmt.Errorf("publication %s version rollback", role)
		}
	}
	if len(descriptors) == 0 {
		return nil, errors.New("publication has no descriptors")
	}
	if len(used) != len(bundle.Files) {
		return nil, errors.New("unreferenced publication files")
	}
	sum := sha256.Sum256(timestamp)
	return json.Marshal(struct {
		GraphVerified bool                       `json:"graphVerified"`
		Timestamp     string                     `json:"timestampSha256"`
		Versions      map[string]int64           `json:"versions"`
		Descriptors   map[string]json.RawMessage `json:"descriptors"`
	}{true, hex.EncodeToString(sum[:]), versions, descriptors})
}
func strongPublicationReference(ref *metadata.MetaFiles) bool {
	return ref != nil && ref.Version > 0 && ref.Length > 0 && ref.Length <= maxBytes && len(ref.Hashes["sha256"]) == 32
}
