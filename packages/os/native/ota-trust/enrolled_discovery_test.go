package otatrust

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type enrolledFixture struct {
	directory, schedule, cache, admission, prepared string
	device                                          []byte
	session                                         *EnrolledDiscovery
	transport                                       *discoveryFixture
}

func enrolledTest(t *testing.T) *enrolledFixture {
	t.Helper()
	state, v := rememberedFixture(t)
	r := fixture(t)
	r.body = v.Release
	r.publish(t, 1)
	var device admissionDevice
	if e := json.Unmarshal(v.Device, &device); e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(r.root)
	config, _ := json.Marshal(enrollmentConfig{Schema: 1, Repository: "eliza-research/senior-care", Distribution: device.Distribution, Signer: device.Signer, RootHash: hex.EncodeToString(sum[:]), MetadataBase: baseURL, Hosts: []string{"updates.example.com", "github.com"}})
	directory := enrollmentDirectory(t)
	if e := InitializeEnrollment(directory, config, r.root); e != nil {
		t.Fatal(e)
	}
	enrollment, e := ReadEnrollment(directory)
	if e != nil {
		t.Fatal(e)
	}
	device.CohortID = enrollment.CohortID
	data, _ := json.Marshal(device)
	transport := &discoveryFixture{repository: r}
	session, e := newEnrolledDiscovery(directory, func(hosts string) (discoveryTransport, error) {
		if hosts != "updates.example.com,github.com" {
			t.Fatal("transport hosts not from enrollment")
		}
		return transport, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	session.session.source = &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}
	schedule, cache := discoveryDirs(t)
	return &enrolledFixture{directory, schedule, cache, state, privateDir(t), data, session, transport}
}
func (f *enrolledFixture) run() (*DiscoveryResult, error) {
	return f.session.RunWithTimeSource(f.schedule, f.cache, f.admission, f.prepared, f.device, 1, 0)
}
func TestEnrolledDiscoveryAuthenticatesAndPrepares(t *testing.T) {
	f := enrolledTest(t)
	result, e := f.run()
	if e != nil || result.Status != "admitted" || !validHex(result.AuthorizationID) || !bytes.Equal(result.Descriptor, f.transport.repository.body) {
		t.Fatalf("%+v %v", result, e)
	}
	if _, e = loadRecovery(f.prepared, f.admission, result.AuthorizationID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.run(); e == nil {
		t.Fatal("single-use session reused")
	}
	if f.transport.closeCount < 1 {
		t.Fatal("transport leaked")
	}
}
func TestEnrolledDiscoveryRejectsChangedObservationsBeforeNetwork(t *testing.T) {
	for _, field := range []string{"signerSha256", "distribution", "opaqueCohortId"} {
		t.Run(field, func(t *testing.T) {
			f := enrolledTest(t)
			called := false
			f.transport.hook = func() { called = true }
			f.device = mutateAdmission(t, f.device, func(device map[string]any) {
				switch field {
				case "signerSha256":
					device[field] = strings.Repeat("f", 64)
				case "distribution":
					device[field] = "standalone"
				case "opaqueCohortId":
					device[field] = "other-device"
				}
			})
			if result, e := f.run(); e == nil || result != nil {
				t.Fatal("mismatched observation accepted")
			}
			if called {
				t.Fatal("network ran before enrollment binding")
			}
			if f.transport.closeCount == 0 {
				t.Fatal("transport leaked")
			}
			if _, e := os.Stat(filepath.Join(f.schedule, "schedule.json")); !os.IsNotExist(e) {
				t.Fatal("invalid observation consumed schedule")
			}
		})
	}
}
func TestEnrolledDiscoveryRejectsEnrollmentLossDuringFetch(t *testing.T) {
	for _, phase := range []string{"before", "during"} {
		t.Run(phase, func(t *testing.T) {
			f := enrolledTest(t)
			remove := func() {
				if e := os.Remove(filepath.Join(f.directory, "enrollment.json")); e != nil {
					t.Fatal(e)
				}
			}
			if phase == "before" {
				remove()
			} else {
				f.transport.hook = remove
			}
			if result, e := f.run(); e == nil || result != nil {
				t.Fatal("exposed result after enrollment loss")
			}
			if f.transport.closeCount == 0 {
				t.Fatal("transport leaked")
			}
		})
	}
}
func TestEnrolledDiscoveryHonorsClockFloorAndCancellation(t *testing.T) {
	for _, mode := range []string{"clock", "floor", "generation", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := enrolledTest(t)
			stamp, floor, generation := now.UnixMilli(), int64(1), int64(0)
			switch mode {
			case "clock":
				stamp = 0
			case "floor":
				floor = 0
			case "generation":
				generation = -1
			case "cancel":
				f.session.Close()
			}
			f.session.session.source = &fixtureTimeSource{bounds: TrustedTimeInterval{stamp, stamp}}
			result, e := f.session.RunWithTimeSource(f.schedule, f.cache, f.admission, f.prepared, f.device, floor, generation)
			if e == nil || result != nil {
				t.Fatal("invalid invocation accepted")
			}
		})
	}
	// A valid raised floor defers, rather than bypassing remembered policy.
	f := enrolledTest(t)
	result, e := f.session.RunWithTimeSource(f.schedule, f.cache, f.admission, f.prepared, f.device, 100, 0)
	if e != nil || result.Status != "deferred" || len(result.Descriptor) != 0 || result.AuthorizationID != "" {
		t.Fatalf("raised floor bypassed %+v %v", result, e)
	}
}
