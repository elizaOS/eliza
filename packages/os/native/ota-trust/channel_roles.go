package otatrust

import (
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// This product uses a closed delegation graph. Top-level targets may authorize
// channel keys but cannot directly supply releases; channel publishers have no
// cross-channel, root, snapshot or freshness authority.
func validateChannelRoles(root *metadata.Metadata[metadata.RootType], top *metadata.Metadata[metadata.TargetsType]) error {
	if root == nil || top == nil || len(top.Signed.Targets) != 0 || top.Signed.Delegations == nil {
		return errors.New("separate channel delegations required")
	}
	d := top.Signed.Delegations
	if d.SuccinctRoles != nil || len(d.Roles) != 2 || len(d.Keys) < 2 || len(d.Keys) > 32 {
		return errors.New("unsupported channel delegation graph")
	}
	identities := map[[32]byte]bool{}
	for _, key := range root.Signed.Keys {
		id, err := publicIdentity(key)
		if err != nil {
			return err
		}
		identities[id] = true
	}
	roles := map[string]bool{}
	used := map[string]bool{}
	for _, role := range d.Roles {
		if (role.Name != "stable" && role.Name != "beta") || roles[role.Name] || !role.Terminating || len(role.PathHashPrefixes) != 0 || len(role.Paths) != 2 || len(role.KeyIDs) < 1 || len(role.KeyIDs) > 16 || role.Threshold < 1 || role.Threshold > len(role.KeyIDs) {
			return errors.New("invalid channel delegation")
		}
		roles[role.Name] = true
		paths := map[string]bool{}
		for _, p := range role.Paths {
			if paths[p] || (p != role.Name+"/launcher.json" && p != role.Name+"/standalone.json") {
				return errors.New("channel delegation path escape")
			}
			paths[p] = true
		}
		for _, id := range role.KeyIDs {
			key := d.Keys[id]
			if key == nil || used[id] {
				return errors.New("missing or shared channel key")
			}
			canonical, err := key.ID()
			if err != nil || canonical != id {
				return errors.New("noncanonical channel key ID")
			}
			identity, err := publicIdentity(key)
			if err != nil {
				return err
			}
			if identities[identity] {
				return errors.New("channel key shares another authority")
			}
			identities[identity] = true
			used[id] = true
		}
	}
	if len(used) != len(d.Keys) {
		return errors.New("unused channel keys")
	}
	return nil
}
func publicIdentity(key *metadata.Key) ([32]byte, error) {
	if key == nil {
		return [32]byte{}, errors.New("missing public key")
	}
	public, err := key.ToPublicKey()
	if err != nil {
		return [32]byte{}, err
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(der), nil
}
func validateChannelTargets(channel string, targets *metadata.Metadata[metadata.TargetsType]) error {
	if targets == nil || targets.Signed.Delegations != nil || len(targets.Signed.Targets) < 1 || len(targets.Signed.Targets) > 2 {
		return errors.New("invalid channel target metadata")
	}
	for path := range targets.Signed.Targets {
		if path != channel+"/launcher.json" && path != channel+"/standalone.json" {
			return errors.New("cross-channel target forbidden")
		}
	}
	return nil
}
