package otatrust

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const baseURL = "https://updates.example.com/metadata/"

var now = time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)

type repository struct {
	files       map[string][]byte
	root        []byte
	signers     map[string]signature.Signer
	body        []byte
	channelKeys map[string]*metadata.Key
}

func (r *repository) Fetch(address string, limit int64) (*Response, error) {
	data, ok := r.files[address]
	if !ok {
		return &Response{Status: 404}, nil
	}
	return &Response{Status: 200, Data: data}, nil
}
func fixture(t *testing.T) *repository {
	t.Helper()
	r := &repository{files: map[string][]byte{}, signers: map[string]signature.Signer{}, channelKeys: map[string]*metadata.Key{}, body: []byte(`{"releaseId":"fixture"}`)}
	root := metadata.Root(now.Add(365 * 24 * time.Hour))
	root.Signed.ConsistentSnapshot = true
	for _, role := range []string{"root", "timestamp", "snapshot", "targets", "stable", "beta"} {
		_, priv, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		key, err := metadata.KeyFromPublicKey(priv.Public())
		if err != nil {
			t.Fatal(err)
		}
		if role == "stable" || role == "beta" {
			r.channelKeys[role] = key
		} else if err = root.Signed.AddKey(key, role); err != nil {
			t.Fatal(err)
		}
		r.signers[role], err = signature.LoadSigner(priv, crypto.Hash(0))
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := root.Sign(r.signers["root"]); err != nil {
		t.Fatal(err)
	}
	var err error
	r.root, err = root.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	r.publish(t, 1)
	return r
}
func (r *repository) publish(t *testing.T, version int64) {
	r.publishDistribution(t, version, "launcher")
}
func (r *repository) publishDistribution(t *testing.T, version int64, distribution string) {
	t.Helper()
	if distribution != "launcher" && distribution != "standalone" {
		t.Fatal("Invalid fixture distribution")
	}
	targets := metadata.Targets(now.Add(24 * time.Hour))
	targets.Signed.Version = version
	target, err := metadata.TargetFile().FromBytes("stable/"+distribution+".json", r.body, "sha256")
	if err != nil {
		t.Fatal(err)
	}
	targets.Signed.Delegations = &metadata.Delegations{Keys: map[string]*metadata.Key{}}
	for _, channel := range []string{"stable", "beta"} {
		key := r.channelKeys[channel]
		id, e := key.ID()
		if e != nil {
			t.Fatal(e)
		}
		targets.Signed.Delegations.Keys[id] = key
		targets.Signed.Delegations.Roles = append(targets.Signed.Delegations.Roles, metadata.DelegatedRole{Name: channel, KeyIDs: []string{id}, Threshold: 1, Terminating: true, Paths: []string{channel + "/launcher.json", channel + "/standalone.json"}})
	}
	stable := metadata.Targets(now.Add(24 * time.Hour))
	stable.Signed.Version = version
	stable.Signed.Targets["stable/"+distribution+".json"] = target
	if _, err = stable.Sign(r.signers["stable"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+fmt.Sprintf("%d.stable.json", version)], err = stable.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	beta := metadata.Targets(now.Add(24 * time.Hour))
	beta.Signed.Version = version
	if _, err = beta.Sign(r.signers["beta"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+fmt.Sprintf("%d.beta.json", version)], err = beta.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := metadata.Snapshot(now.Add(24 * time.Hour))
	snapshot.Signed.Version = version
	snapshot.Signed.Meta["targets.json"].Version = version
	snapshot.Signed.Meta["stable.json"] = &metadata.MetaFiles{Version: version}
	snapshot.Signed.Meta["beta.json"] = &metadata.MetaFiles{Version: version}
	timestamp := metadata.Timestamp(now.Add(time.Hour))
	timestamp.Signed.Version = version
	timestamp.Signed.Meta["snapshot.json"].Version = version
	if _, err = targets.Sign(r.signers["targets"]); err != nil {
		t.Fatal(err)
	}
	if _, err = snapshot.Sign(r.signers["snapshot"]); err != nil {
		t.Fatal(err)
	}
	if _, err = timestamp.Sign(r.signers["timestamp"]); err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+fmt.Sprintf("%d.targets.json", version)], err = targets.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+fmt.Sprintf("%d.snapshot.json", version)], err = snapshot.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"timestamp.json"], err = timestamp.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(r.body)
	r.files[baseURL+"targets/stable/"+hex.EncodeToString(digest[:])+"."+distribution+".json"] = r.body
}
func fetch(dir string, r *repository, clock time.Time) ([]byte, error) {
	return FetchDescriptorInterval(dir, r.root, baseURL, "stable", "launcher", clock.UnixMilli(), clock.UnixMilli(), r)
}
func TestAuthenticatedTargetAndRestart(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	for i := 0; i < 2; i++ {
		data, err := fetch(dir, r, now)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, r.body) {
			t.Fatal("wrong authenticated target")
		}
	}
}
func TestTamperedTarget(t *testing.T) {
	r := fixture(t)
	for key := range r.files {
		if bytes.Contains([]byte(key), []byte("targets/stable/")) {
			r.files[key] = []byte(`{"releaseId":"attacker"}`)
		}
	}
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("tampered target accepted")
	}
}
func TestWrongMetadataSigner(t *testing.T) {
	r := fixture(t)
	other := fixture(t)
	r.files[baseURL+"timestamp.json"] = other.files[baseURL+"timestamp.json"]
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("wrong timestamp signer accepted")
	}
}
func TestExpiryAndRollback(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	r.publish(t, 2)
	if _, err := fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	r.publish(t, 1)
	if _, err := fetch(dir, r, now); err == nil {
		t.Fatal("timestamp rollback accepted")
	}
	if _, err := fetch(privateDir(t), r, now.Add(2*time.Hour)); err == nil {
		t.Fatal("expired timestamp accepted")
	}
}
func TestChannelSeparationAndInputBounds(t *testing.T) {
	r := fixture(t)
	if _, err := FetchDescriptorInterval(privateDir(t), r.root, baseURL, "beta", "launcher", now.UnixMilli(), now.UnixMilli(), r); err == nil {
		t.Fatal("stable target used for beta")
	}
	if _, err := FetchDescriptorInterval(privateDir(t), r.root, baseURL, "stable", "launcher", 0, 0, r); err == nil {
		t.Fatal("unknown time accepted")
	}
	if _, err := FetchDescriptorInterval(privateDir(t), r.root, "http://updates.example.com/", "stable", "launcher", now.UnixMilli(), now.UnixMilli(), r); err == nil {
		t.Fatal("HTTP accepted")
	}
}
func TestUnsafeCacheRefused(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	outside := filepath.Join(privateDir(t), "root.json")
	if err := os.WriteFile(outside, r.root, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "root.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := fetch(dir, r, now); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestFetcherBudgetsAndAuthority(t *testing.T) {
	r := fixture(t)
	f := &boundedFetcher{transport: r, prefix: baseURL, remaining: 2 * maxBytes}
	for _, address := range []string{"http://updates.example.com/metadata/x", "https://other.example.com/metadata/x", baseURL + "../x", baseURL + "%2e%2e/x", baseURL + "x?token=x"} {
		if _, err := f.DownloadFile(address, 16, 0); err == nil {
			t.Fatal("unsafe URL accepted")
		}
	}
	if _, err := f.DownloadFile(baseURL+"timestamp.json", 1, 0); err == nil {
		t.Fatal("oversized response accepted")
	}
	f.requests = 128
	if _, err := f.DownloadFile(baseURL+"timestamp.json", 16384, 0); err == nil {
		t.Fatal("request budget ignored")
	}
}

func privateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}
func TestMissingCachedRootFailsClosed(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	if _, err := fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "root.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := fetch(dir, r, now); err == nil {
		t.Fatal("missing cached root silently reset")
	}
}

func TestTimeFloorSurvivesRestart(t *testing.T) {
	r := fixture(t)
	dir := privateDir(t)
	if _, err := fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	if _, err := fetch(dir, r, now.Add(-time.Second)); err == nil {
		t.Fatal("time rollback accepted")
	}
	if err := os.Remove(filepath.Join(dir, ".clock")); err != nil {
		t.Fatal(err)
	}
	if _, err := fetch(dir, r, now); err == nil {
		t.Fatal("missing time floor accepted")
	}
}

func TestDuplicateJSONRejected(t *testing.T) {
	for _, data := range []string{`{"version":1,"version":2}`, `{"x":{"role":1,"\u0072ole":2}}`, `{} {}`, `{"a":1,}`} {
		if checkJSON([]byte(data)) == nil {
			t.Fatal("ambiguous JSON accepted")
		}
	}
	if err := checkJSON([]byte(`{"a":[1,true,null,{"b":"value"}]}`)); err != nil {
		t.Fatal(err)
	}
}

func TestSequentialRootRotationAndRestart(t *testing.T) {
	r := fixture(t)
	rotated, err := metadata.Root().FromBytes(r.root)
	if err != nil {
		t.Fatal(err)
	}
	rotated.Signed.Version = 2
	rotated.Signatures = nil
	if _, err = rotated.Sign(r.signers["root"]); err != nil {
		t.Fatal(err)
	}
	data, err := rotated.ToBytes(false)
	if err != nil {
		t.Fatal(err)
	}
	r.files[baseURL+"2.root.json"] = data
	dir := privateDir(t)
	if _, err = fetch(dir, r, now); err != nil {
		t.Fatal(err)
	}
	cached, err := os.ReadFile(filepath.Join(dir, "root.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(cached, data) {
		t.Fatal("rotated root not persisted")
	}
	delete(r.files, baseURL+"2.root.json")
	if _, err = fetch(dir, r, now); err != nil {
		t.Fatal("restart discarded rotated root", err)
	}
}
func TestRootReplayAtNextVersionRejected(t *testing.T) {
	r := fixture(t)
	r.files[baseURL+"2.root.json"] = r.root
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("old root at next-version URL accepted")
	}
}

// Generates only public metadata and target bytes for the Android test APK.
// Ephemeral signing keys remain in memory and are never exported.
func TestExportAndroidFixture(t *testing.T) {
	dir := os.Getenv("SENIOR_CARE_OTA_TEST_ASSETS")
	if dir == "" {
		t.Skip("Android fixture export not requested")
	}
	r := fixture(t)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	exportStagingFixture(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "root.json"), r.root, 0600); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(r.files)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "responses.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	preparedDir, admissionDir, preparedID, _ := preparedFixture(t)
	for source, target := range map[string]string{filepath.Join(preparedDir, preparedID+".json"): "prepared-fixture.json", filepath.Join(admissionDir, "admission.json"): "admission-state-fixture.json"} {
		bytes, e := os.ReadFile(source)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(dir, target), bytes, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := os.WriteFile(filepath.Join(dir, "prepared-fixture-id.txt"), []byte(preparedID), 0600); e != nil {
		t.Fatal(e)
	}
	runtimeAPK, runtimeMetadata := runtimeAPKFixture(t, "valid")
	apkBytes, e := os.ReadFile(runtimeAPK)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "runtime-fixture.apk"), apkBytes, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "runtime-fixture.json"), runtimeMetadata, 0600); e != nil {
		t.Fatal(e)
	}
	vectors, err := os.ReadFile("testdata/admission.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "admission.json"), vectors, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentTrustSessionFailsWithoutWaiting(t *testing.T) {
	r := fixture(t)
	sessionLock.Lock()
	defer sessionLock.Unlock()
	started := time.Now()
	if _, err := fetch(privateDir(t), r, now); err == nil {
		t.Fatal("overlapping session admitted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("overlapping session queued indefinitely")
	}
}
