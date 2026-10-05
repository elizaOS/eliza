package otatrust

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func boundMeta(data []byte, v int64) *metadata.MetaFiles {
	h := sha256.Sum256(data)
	return &metadata.MetaFiles{Version: v, Length: int64(len(data)), Hashes: metadata.Hashes{"sha256": h[:]}}
}
func publicationFixture(t *testing.T) (*repository, publicationBundle, []byte) {
	r := fixture(t)
	snapshot, err := metadata.Snapshot().FromBytes(r.files[baseURL+"1.snapshot.json"])
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"targets", "stable", "beta"} {
		snapshot.Signed.Meta[role+".json"] = boundMeta(r.files[baseURL+"1."+role+".json"], 1)
	}
	snapshot.Signatures = nil
	if _, err = snapshot.Sign(r.signers["snapshot"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"1.snapshot.json"], err = snapshot.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	timestamp, err := metadata.Timestamp().FromBytes(r.files[baseURL+"timestamp.json"])
	if err != nil {
		t.Fatal(err)
	}
	timestamp.Signed.Meta["snapshot.json"] = boundMeta(r.files[baseURL+"1.snapshot.json"], 1)
	timestamp.Signatures = nil
	if _, err = timestamp.Sign(r.signers["timestamp"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"timestamp.json"], err = timestamp.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	b := publicationBundle{Files: map[string][]byte{}}
	for name, data := range r.files {
		b.Files[strings.TrimPrefix(name, baseURL)] = data
	}
	p, _ := json.Marshal(publicationPolicy{Upper: now.UnixMilli(), Minimum: map[string]int64{"root": 1, "timestamp": 1, "snapshot": 1, "targets": 1, "stable": 1, "beta": 1}})
	return r, b, p
}
func checkPublication(t *testing.T, r *repository, b publicationBundle, p []byte) ([]byte, error) {
	t.Helper()
	data, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	return VerifyPublicationGraph(r.root, data, p)
}
func TestPublicationGraphAuthenticatesCompleteClosure(t *testing.T) {
	r, b, p := publicationFixture(t)
	result, err := checkPublication(t, r, b, p)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		GraphVerified bool                       `json:"graphVerified"`
		Descriptors   map[string]json.RawMessage `json:"descriptors"`
	}
	if err = json.Unmarshal(result, &report); err != nil || !report.GraphVerified || string(report.Descriptors["stable/launcher.json"]) != string(r.body) {
		t.Fatalf("wrong report %s %v", result, err)
	}
}
func TestPublicationGraphRejectsMissingAndTamperedDependencies(t *testing.T) {
	_, reference, _ := publicationFixture(t)
	for name := range reference.Files {
		for _, tamper := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%t", name, tamper), func(t *testing.T) {
				r, b, p := publicationFixture(t)
				if tamper {
					b.Files[name] = []byte(`{"signed":{},"signatures":[]}`)
				} else {
					delete(b.Files, name)
				}
				if _, err := checkPublication(t, r, b, p); err == nil {
					t.Fatal("Incomplete/tampered graph accepted")
				}
			})
		}
	}
}
func TestPublicationGraphRejectsFloorsExpiryAndExtraFiles(t *testing.T) {
	for _, role := range []string{"root", "timestamp", "snapshot", "targets", "stable", "beta"} {
		t.Run(role, func(t *testing.T) {
			r, b, p := publicationFixture(t)
			var policy publicationPolicy
			json.Unmarshal(p, &policy)
			policy.Minimum[role] = 2
			p, _ = json.Marshal(policy)
			if _, err := checkPublication(t, r, b, p); err == nil {
				t.Fatal("Role rollback accepted")
			}
		})
	}
	r, b, p := publicationFixture(t)
	var policy publicationPolicy
	json.Unmarshal(p, &policy)
	policy.Upper = now.Add(3600 * 1000000000).UnixMilli()
	p, _ = json.Marshal(policy)
	if _, err := checkPublication(t, r, b, p); err == nil {
		t.Fatal("Exact expiry accepted")
	}
	r, b, p = publicationFixture(t)
	b.Files["untrusted.json"] = []byte(`{}`)
	if _, err := checkPublication(t, r, b, p); err == nil {
		t.Fatal("Unreferenced file accepted")
	}
}
func TestPublicationGraphRequiresStrongHashLinksAndChannelSignatures(t *testing.T) {
	r := fixture(t)
	b := publicationBundle{Files: map[string][]byte{}}
	for n, v := range r.files {
		b.Files[strings.TrimPrefix(n, baseURL)] = v
	}
	_, _, p := publicationFixture(t)
	if _, err := checkPublication(t, r, b, p); err == nil || !strings.Contains(err.Error(), "exact snapshot") {
		t.Fatalf("Weak links accepted %v", err)
	}
	r, b, p = publicationFixture(t)
	rewriteRole(t, r, "1.stable.json", "beta", func(*metadata.Metadata[metadata.TargetsType]) {})
	b.Files["1.stable.json"] = r.files[baseURL+"1.stable.json"]
	if _, err := checkPublication(t, r, b, p); err == nil {
		t.Fatal("Beta-signed Stable accepted")
	}
}
func TestPublicationGraphRejectsDuplicateOuterKeys(t *testing.T) {
	r, _, p := publicationFixture(t)
	if _, err := VerifyPublicationGraph(r.root, []byte(`{"files":{},"files":{}}`), p); err == nil {
		t.Fatal("Duplicate container keys accepted")
	}
}

func TestPublicationGraphCommand(t *testing.T) {
	r, b, p := publicationFixture(t)
	dir := t.TempDir()
	bundle, _ := json.Marshal(b)
	for name, data := range map[string][]byte{"root.json": r.root, "bundle.json": bundle, "policy.json": p} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "go", "run", "./cmd/verify-publication", "-root", filepath.Join(dir, "root.json"), "-bundle", filepath.Join(dir, "bundle.json"), "-policy", filepath.Join(dir, "policy.json"))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("CLI failed: %s %v", output, err)
	}
	var report map[string]any
	if err = json.Unmarshal(output, &report); err != nil || report["graphVerified"] != true {
		t.Fatalf("Invalid CLI output %s %v", output, err)
	}
}
