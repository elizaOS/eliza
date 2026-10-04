package otatrust

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

type stagingFixture struct {
	enrollment, prepared, admission, cache, id string
	device                                     []byte
	candidate, recovery                        []byte
	descriptor                                 releaseDescriptor
	order                                      []string
	mu                                         sync.Mutex
	hook                                       func(string)
	primaryFailure                             bool
	retryAfter                                 bool
}

func stageFixture(t *testing.T) *stagingFixture {
	t.Helper()
	state, v := rememberedFixture(t)
	r := fixture(t)
	f := &stagingFixture{enrollment: privateDir(t), prepared: privateDir(t), admission: state, cache: privateDir(t), candidate: []byte(strings.Repeat("candidate", 128)), recovery: []byte(strings.Repeat("recovery", 128))}
	json.Unmarshal(v.Release, &f.descriptor)
	ch, rh := sha256.Sum256(f.candidate), sha256.Sum256(f.recovery)
	f.descriptor.Candidate.SHA256 = hex.EncodeToString(ch[:])
	f.descriptor.Candidate.Length = int64(len(f.candidate))
	f.descriptor.Recovery.SHA256 = hex.EncodeToString(rh[:])
	f.descriptor.Recovery.Length = int64(len(f.recovery))
	f.descriptor.Safety.RecoveryFor = f.descriptor.Candidate.SHA256
	f.descriptor.Recovery.Compatibility.Origins = []string{f.descriptor.Candidate.SHA256}
	f.descriptor.Candidate.Mirrors = []string{"https://updates.example.com/2.apk"}
	f.descriptor.Recovery.Mirrors = []string{"https://updates.example.com/3.apk"}
	rootHash := sha256.Sum256(r.root)
	c := enrollmentConfig{Schema: 1, Repository: f.descriptor.Source.Repository, Distribution: "launcher", Signer: f.descriptor.Candidate.Signer, RootHash: hex.EncodeToString(rootHash[:]), MetadataBase: baseURL, Hosts: []string{"updates.example.com", "github.com"}}
	config, _ := json.Marshal(c)
	if e := InitializeEnrollment(f.enrollment, config, r.root); e != nil {
		t.Fatal(e)
	}
	enrolled, e := ReadEnrollment(f.enrollment)
	if e != nil {
		t.Fatal(e)
	}
	var device admissionDevice
	json.Unmarshal(v.Device, &device)
	device.CohortID = enrolled.CohortID
	f.device, _ = json.Marshal(device)
	policy := admissionPolicy{Repository: c.Repository, Hosts: c.Hosts, Lower: now.UnixMilli(), Upper: now.UnixMilli(), Sequence: 1, Revision: 1, SecurityFloor: 1}
	p, _ := json.Marshal(policy)
	release, _ := json.Marshal(f.descriptor)
	// Use authentic discovery to produce the authorization, not a forged local record.
	r.body = release
	r.publish(t, 1)
	schedule, cache := discoveryDirs(t)
	session := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
	result, e := session.RunPrepared(schedule, cache, state, f.prepared, r.root, baseURL, f.device, p, 0)
	if e != nil || result.Status != "admitted" {
		t.Fatalf("%+v %v", result, e)
	}
	f.id = result.AuthorizationID
	return f
}
func (f *stagingFixture) newStager(t *testing.T) *PreparedStager {
	t.Helper()
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		name := "candidate"
		body := f.candidate
		if strings.HasSuffix(r.URL.Path, "/3.apk") {
			name = "recovery"
			body = f.recovery
		}
		f.mu.Lock()
		f.order = append(f.order, name)
		hook := f.hook
		f.mu.Unlock()
		if hook != nil {
			hook(name)
		}
		if f.primaryFailure && r.Host == "github.com" {
			if f.retryAfter {
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(503)
			} else {
				w.WriteHeader(404)
			}
			return
		}
		w.Header().Set("ETag", `"pair"`)
		w.Write(body)
	})
	transport.hosts["github.com"] = true
	transport.hosts["updates.example.com"] = true
	transport.client.Transport.(*http.Transport).TLSClientConfig.ServerName = "example.com" // local test certificate only
	stager, e := newPreparedStager(f.enrollment, func(hosts string) (*ArtifactDownloader, error) {
		if hosts != "updates.example.com,github.com" {
			t.Fatal("wrong enrolled hosts")
		}
		return &ArtifactDownloader{transport: transport}, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	stager.source = &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}
	return stager
}
func (f *stagingFixture) run(s *PreparedStager) (*StagedPair, error) {
	return s.StageWithTimeSource(f.prepared, f.admission, f.cache, f.id, f.device, 1, 0, 1024)
}
func TestStagingDownloadsRecoveryFirstAndReusesVerifiedPair(t *testing.T) {
	f := stageFixture(t)
	s := f.newStager(t)
	result, e := f.run(s)
	if e != nil {
		t.Fatal(e)
	}
	if result.AuthorizationID != f.id || result.Generation != 0 || len(result.Descriptor) == 0 {
		t.Fatal("wrong pair binding")
	}
	f.mu.Lock()
	order := append([]string(nil), f.order...)
	f.mu.Unlock()
	if strings.Join(order, ",") != "recovery,candidate" {
		t.Fatal(order)
	}
	if e = verifyArtifact(result.CandidatePath, f.descriptor.Candidate.SHA256, int64(len(f.candidate))); e != nil {
		t.Fatal(e)
	}
	if e = verifyArtifact(result.RecoveryPath, f.descriptor.Recovery.SHA256, int64(len(f.recovery))); e != nil {
		t.Fatal(e)
	}
	if _, e = f.run(s); e == nil {
		t.Fatal("single-use staging reused")
	}
	again, e := f.run(f.newStager(t))
	if e != nil || again.CandidatePath != result.CandidatePath {
		t.Fatal(e)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.order) != 2 {
		t.Fatal("verified cache redownloaded")
	}
}
func TestStagingNeverReturnsPartialOrRevokedPair(t *testing.T) {
	for _, mode := range []string{"corrupt-recovery", "corrupt-candidate", "cancel", "lost-authorization", "revoked", "lost-enrollment"} {
		t.Run(mode, func(t *testing.T) {
			f := stageFixture(t)
			s := f.newStager(t)
			switch mode {
			case "corrupt-recovery":
				f.recovery = []byte("bad")
			case "corrupt-candidate":
				f.candidate = []byte("bad")
			default:
				f.hook = func(name string) {
					if name != "recovery" {
						return
					}
					switch mode {
					case "cancel":
						s.Close()
					case "lost-authorization":
						os.Remove(filepath.Join(f.prepared, f.id+".json"))
					case "lost-enrollment":
						os.Remove(filepath.Join(f.enrollment, "enrollment.json"))
					case "revoked":
						e := lockedAdmission(f.admission, func() error {
							state, e := readAdmission(f.admission)
							if e != nil {
								return e
							}
							floor := state.Lanes["stable"]
							floor.Revoked = append(floor.Revoked, f.descriptor.Candidate.SHA256)
							state.Lanes["stable"] = floor
							return saveAdmission(f.admission, *state, nil)
						})
						if e != nil {
							t.Error(e)
						}
					}
				}
			}
			result, e := f.run(s)
			if e == nil || result != nil {
				t.Fatal("unsafe pair returned")
			}
			if mode != "corrupt-candidate" {
				f.mu.Lock()
				defer f.mu.Unlock()
				expected := 1
				if mode == "corrupt-recovery" {
					expected = 2
				}
				if len(f.order) != expected {
					t.Fatal("candidate fetched after recovery/admission failure", f.order)
				}
			}
		})
	}
}
func TestStagingRejectsStaleGenerationAndUnsafeCache(t *testing.T) {
	f := stageFixture(t)
	s := f.newStager(t)
	if result, e := s.StageWithTimeSource(f.prepared, f.admission, f.cache, f.id, f.device, 1, 1, 1024); e == nil || result != nil {
		t.Fatal("stale generation accepted")
	}
	path := filepath.Join(f.cache, f.descriptor.Candidate.SHA256+".apk")
	if e := syscall.Mkfifo(path, 0600); e != nil {
		t.Fatal(e)
	}
	// Nonblocking integrity open must reject a FIFO without hanging on a writer.
	if e := verifyArtifact(path, f.descriptor.Candidate.SHA256, int64(len(f.candidate))); e == nil {
		t.Fatal("FIFO accepted")
	}
	if result, e := f.run(f.newStager(t)); e == nil || result != nil {
		t.Fatal("unsafe pair cache accepted")
	}
}
func TestStagingSerializesWholePair(t *testing.T) {
	f := stageFixture(t)
	first, second := f.newStager(t), f.newStager(t)
	entered, release := make(chan struct{}), make(chan struct{})
	f.hook = func(name string) {
		if name == "recovery" {
			close(entered)
			<-release
		}
	}
	done := make(chan error, 1)
	go func() { _, e := f.run(first); done <- e }()
	<-entered
	if result, e := f.run(second); e == nil || result != nil {
		t.Error("parallel pair admitted")
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}

func TestStagingUsesOnlyAuthorizedMirrorsAndHonorsBackoff(t *testing.T) {
	for _, backoff := range []bool{false, true} {
		f := stageFixture(t)
		f.primaryFailure = true
		f.retryAfter = backoff
		s := f.newStager(t)
		result, err := f.run(s)
		if backoff {
			if err == nil || result != nil || s.RetryAfterMillis() < 59000 {
				t.Fatal("server backoff bypassed", err)
			}
			f.mu.Lock()
			if len(f.order) != 1 {
				t.Fatal("mirror bypassed backoff")
			}
			f.mu.Unlock()
		} else if err != nil || result == nil {
			t.Fatal("authorized mirror failed", err)
		}
	}
}
func exportStagingFixture(t *testing.T, directory string) {
	f := stageFixture(t)
	files := map[string][]byte{"stage-id.txt": []byte(f.id), "stage-device.json": f.device, "stage-candidate.bin": f.candidate, "stage-recovery.bin": f.recovery}
	for name, path := range map[string]string{"stage-enrollment.json": filepath.Join(f.enrollment, "enrollment.json"), "stage-prepared.json": filepath.Join(f.prepared, f.id+".json"), "stage-admission.json": filepath.Join(f.admission, "admission.json")} {
		data, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		files[name] = data
	}
	for name, data := range files {
		if e := os.WriteFile(filepath.Join(directory, name), data, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
