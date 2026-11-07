package otatrust

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"strings"
	"testing"
)

func rewriteRole(t *testing.T, r *repository, file, signer string, change func(*metadata.Metadata[metadata.TargetsType])) {
	t.Helper()
	m, err := metadata.Targets().FromBytes(r.files[baseURL+file])
	if err != nil {
		t.Fatal(err)
	}
	change(m)
	m.Signatures = nil
	if signer == "stable" || signer == "beta" {
		r.signChannel(t, m, signer)
	} else if _, err = m.Sign(r.signers[signer]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+file], err = m.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
}
func TestChannelDelegationPolicy(t *testing.T) {
	cases := map[string]struct {
		change func(*metadata.Metadata[metadata.TargetsType])
		want   string
	}{
		"missing": {func(m *metadata.Metadata[metadata.TargetsType]) { m.Signed.Delegations = nil }, "separate channel"},
		"top-level-bypass": {func(m *metadata.Metadata[metadata.TargetsType]) {
			m.Signed.Targets["stable/launcher.json"] = &metadata.TargetFiles{Length: 1, Hashes: metadata.Hashes{"sha256": make([]byte, 32)}}
		}, "separate channel"},
		"wildcard": {func(m *metadata.Metadata[metadata.TargetsType]) { m.Signed.Delegations.Roles[0].Paths[0] = "*" }, "path escape"},
		"duplicate-path": {func(m *metadata.Metadata[metadata.TargetsType]) {
			m.Signed.Delegations.Roles[0].Paths[1] = m.Signed.Delegations.Roles[0].Paths[0]
		}, "path escape"},
		"nonterminating": {func(m *metadata.Metadata[metadata.TargetsType]) { m.Signed.Delegations.Roles[0].Terminating = false }, "invalid channel"},
		"shared-key": {func(m *metadata.Metadata[metadata.TargetsType]) {
			m.Signed.Delegations.Roles[1].KeyIDs = m.Signed.Delegations.Roles[0].KeyIDs
		}, "shared channel key"},
		"duplicate-role": {func(m *metadata.Metadata[metadata.TargetsType]) { m.Signed.Delegations.Roles[1].Name = "stable" }, "invalid channel"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := fixture(t)
			rewriteRole(t, r, "1.targets.json", "targets", tc.change)
			if _, err := fetch(privateDir(t), r, now); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("wrong rejection: %v", err)
			}
		})
	}
}
func TestBetaKeyCannotSignStable(t *testing.T) {
	r := fixture(t)
	rewriteRole(t, r, "1.stable.json", "beta", func(*metadata.Metadata[metadata.TargetsType]) {})
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("Beta key authorized Stable")
	}
}
func TestChannelTargetsCannotEscapeOrRedelegate(t *testing.T) {
	for _, nested := range []bool{false, true} {
		r := fixture(t)
		rewriteRole(t, r, "1.stable.json", "stable", func(m *metadata.Metadata[metadata.TargetsType]) {
			if nested {
				m.Signed.Delegations = &metadata.Delegations{Keys: map[string]*metadata.Key{}}
			} else {
				m.Signed.Targets["beta/launcher.json"] = m.Signed.Targets["stable/launcher.json"]
			}
		})
		if _, err := fetch(privateDir(t), r, now); err == nil {
			t.Fatal("Channel escaped closed graph")
		}
	}
}
func TestChannelKeysCannotReuseTopLevelAuthority(t *testing.T) {
	r := fixture(t)
	root, err := metadata.Root().FromBytes(r.root)
	if err != nil {
		t.Fatal(err)
	}
	rewriteRole(t, r, "1.targets.json", "targets", func(m *metadata.Metadata[metadata.TargetsType]) {
		id := root.Signed.Roles["targets"].KeyIDs[0]
		m.Signed.Delegations.Keys[id] = root.Signed.Keys[id]
		m.Signed.Delegations.Roles[0].KeyIDs[0] = id
	})
	if _, err = fetch(privateDir(t), r, now); err == nil || !strings.Contains(err.Error(), "shares another authority") {
		t.Fatalf("wrong rejection: %v", err)
	}
}
func TestChannelThresholdRequiresDistinctAuthorizedSignatures(t *testing.T) {
	r := fixture(t)
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	key, err := metadata.KeyFromPublicKey(private.Public())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := key.ID()
	signer, err := signature.LoadSigner(private, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	rewriteRole(t, r, "1.targets.json", "targets", func(m *metadata.Metadata[metadata.TargetsType]) {
		m.Signed.Delegations.Keys[id] = key
		m.Signed.Delegations.Roles[0].KeyIDs = append(m.Signed.Delegations.Roles[0].KeyIDs, id)
		m.Signed.Delegations.Roles[0].Threshold = 3
	})
	if _, err = fetch(privateDir(t), r, now); err == nil {
		t.Fatal("Missing third signature accepted")
	}
	stable, err := metadata.Targets().FromBytes(r.files[baseURL+"1.stable.json"])
	if err != nil {
		t.Fatal(err)
	}
	if _, err = stable.Sign(signer); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"1.stable.json"], err = stable.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := fetch(privateDir(t), r, now); err != nil || !bytes.Equal(data, r.body) {
		t.Fatalf("Threshold-signed channel failed: %v", err)
	}
}
func TestBetaDelegatedTargetAuthenticatesIndependently(t *testing.T) {
	r := fixture(t)
	beta, err := metadata.Targets().FromBytes(r.files[baseURL+"1.stable.json"])
	if err != nil {
		t.Fatal(err)
	}
	target := beta.Signed.Targets["stable/launcher.json"]
	beta.Signed.Targets = map[string]*metadata.TargetFiles{"beta/launcher.json": target}
	beta.Signatures = nil
	r.signChannel(t, beta, "beta")
	r.files[baseURL+"1.beta.json"], err = beta.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := metadata.Snapshot().FromBytes(r.files[baseURL+"1.snapshot.json"])
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Signed.Meta["beta.json"] = &metadata.MetaFiles{Version: 1}
	snapshot.Signatures = nil
	if _, err = snapshot.Sign(r.signers["snapshot"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"1.snapshot.json"], err = snapshot.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(r.body)
	r.files[baseURL+"targets/beta/"+hex.EncodeToString(digest[:])+".launcher.json"] = r.body
	data, err := FetchDescriptorInterval(privateDir(t), r.root, baseURL, "beta", "launcher", now.UnixMilli(), now.UnixMilli(), r)
	if err != nil || !bytes.Equal(data, r.body) {
		t.Fatalf("Beta delegation failed: %v", err)
	}
}

// stableRole returns the fixture's Stable delegation inside top-level targets.
func stableRole(m *metadata.Metadata[metadata.TargetsType]) *metadata.DelegatedRole {
	for i := range m.Signed.Delegations.Roles {
		if m.Signed.Delegations.Roles[i].Name == "stable" {
			return &m.Signed.Delegations.Roles[i]
		}
	}
	return nil
}

// resignStable replaces the Stable metadata signatures with the named signers.
func resignStable(t *testing.T, r *repository, signers ...string) {
	t.Helper()
	m, err := metadata.Targets().FromBytes(r.files[baseURL+"1.stable.json"])
	if err != nil {
		t.Fatal(err)
	}
	m.Signatures = nil
	for _, name := range signers {
		if _, err = m.Sign(r.signers[name]); err != nil {
			t.Fatal(err)
		}
	}
	r.files[baseURL+"1.stable.json"], err = m.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
}

func TestStableRequiresSecondApproval(t *testing.T) {
	r := fixture(t)
	if data, err := fetch(privateDir(t), r, now); err != nil || !bytes.Equal(data, r.body) {
		t.Fatalf("two Stable approvals rejected: %v", err)
	}
	// A delegation that lowers Stable to one approval is refused before any
	// Stable metadata is trusted, even when that metadata carries two signatures.
	for _, keys := range []int{1, 2} {
		r = fixture(t)
		rewriteRole(t, r, "1.targets.json", "targets", func(m *metadata.Metadata[metadata.TargetsType]) {
			role := stableRole(m)
			if keys == 1 {
				delete(m.Signed.Delegations.Keys, role.KeyIDs[1])
				role.KeyIDs = role.KeyIDs[:1]
			}
			role.Threshold = 1
		})
		if _, err := fetch(privateDir(t), r, now); err == nil || !strings.Contains(err.Error(), "stable channel requires 2 distinct approvals") {
			t.Fatalf("single-approval Stable delegation (%d keys) accepted: %v", keys, err)
		}
	}
	// With the delegation intact, one approver signing alone or twice is not enough.
	for _, signers := range [][]string{{"stable"}, {"stable-second"}, {"stable", "stable"}} {
		r = fixture(t)
		resignStable(t, r, signers...)
		if _, err := fetch(privateDir(t), r, now); err == nil {
			t.Fatalf("Stable release with approvals %v accepted", signers)
		}
	}
	// A Beta signature is not a second Stable approval.
	r = fixture(t)
	resignStable(t, r, "stable", "beta")
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("Beta key counted as a Stable approval")
	}
	// The second approver key may not be an alias of the first.
	r = fixture(t)
	rewriteRole(t, r, "1.targets.json", "targets", func(m *metadata.Metadata[metadata.TargetsType]) {
		role := stableRole(m)
		role.KeyIDs[1] = role.KeyIDs[0]
	})
	if _, err := fetch(privateDir(t), r, now); err == nil || !strings.Contains(err.Error(), "shared channel key") {
		t.Fatalf("aliased Stable approver accepted: %v", err)
	}
}

func TestBetaNeedsOneApproval(t *testing.T) {
	r := fixture(t)
	rewriteRole(t, r, "1.targets.json", "targets", func(m *metadata.Metadata[metadata.TargetsType]) {
		for i := range m.Signed.Delegations.Roles {
			if m.Signed.Delegations.Roles[i].Name == "beta" {
				m.Signed.Delegations.Roles[i].Threshold = 0
			}
		}
	})
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("Beta delegation without an approval threshold accepted")
	}
}
