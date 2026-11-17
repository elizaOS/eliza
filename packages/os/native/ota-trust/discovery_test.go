package otatrust

import (
	"bytes"
	"os"
	"testing"
	"time"
)

type discoveryFixture struct {
	*repository
	hint       int64
	closeCount int
	hook       func()
}

func (d *discoveryFixture) Close()                  { d.closeCount++ }
func (d *discoveryFixture) RetryAfterMillis() int64 { return d.hint }
func (d *discoveryFixture) Fetch(address string, limit int64) (*Response, error) {
	if d.hook != nil {
		h := d.hook
		d.hook = nil
		h()
	}
	return d.repository.Fetch(address, limit)
}
func discoveryDirs(t *testing.T) (string, string) {
	t.Helper()
	a, b := t.TempDir(), t.TempDir()
	os.Chmod(a, 0700)
	os.Chmod(b, 0700)
	return a, b
}
func TestDiscoveryAuthenticatesThenDefers(t *testing.T) {
	started := time.Now()
	a, b := discoveryDirs(t)
	r := fixture(t)
	transport := &discoveryFixture{repository: r}
	s := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: transport}
	result, err := s.Run(a, b, r.root, baseURL, "stable", "launcher", 0)
	if err != nil || result.Status != "authenticated" || !bytes.Equal(result.Descriptor, r.body) || result.DelayMillis < 5*60*60*1000 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if transport.closeCount != 1 {
		t.Fatal("transport leaked")
	}
	if _, err = s.Run(a, b, r.root, baseURL, "stable", "launcher", 0); err == nil {
		t.Fatal("session reused")
	}
	later := now.UnixMilli() + time.Since(started).Milliseconds() + 1000
	s = &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{later, later}}, transport: &discoveryFixture{repository: r}}
	result, err = s.Run(a, b, r.root, baseURL, "stable", "launcher", 0)
	if err != nil || result.Status != "deferred" || len(result.Descriptor) != 0 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}
func TestDiscoveryFailurePersistsServerDelay(t *testing.T) {
	a, b := discoveryDirs(t)
	r := fixture(t)
	r.files = map[string][]byte{}
	s := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r, hint: 120000}}
	result, err := s.Run(a, b, r.root, baseURL, "stable", "launcher", 0)
	if err != nil || result.Status != "deferred" || len(result.Descriptor) != 0 || result.DelayMillis < 120000 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	claim, err := BeginDiscoveryInterval(a, now.UnixMilli()+1000, now.UnixMilli()+1000, 1)
	if err != nil || claim.Token != "" || claim.DelayMillis < 119000 {
		t.Fatalf("claim=%+v err=%v", claim, err)
	}
}
func TestDiscoveryCancellationAndChannelRaceDiscardBytes(t *testing.T) {
	for _, change := range []string{"cancel", "channel", "corrupt"} {
		t.Run(change, func(t *testing.T) {
			a, b := discoveryDirs(t)
			r := fixture(t)
			transport := &discoveryFixture{repository: r}
			s := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: transport}
			transport.hook = func() {
				switch change {
				case "cancel":
					s.Close()
				case "channel":
					if _, err := BeginDiscoveryInterval(a, now.UnixMilli(), now.UnixMilli(), 1); err != nil {
						t.Fatal(err)
					}
				case "corrupt":
					if err := os.WriteFile(a+"/schedule.json", []byte("broken"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			result, err := s.Run(a, b, r.root, baseURL, "stable", "launcher", 0)
			if change == "corrupt" {
				if err == nil || result != nil {
					t.Fatal("exposed bytes without durable result")
				}
				return
			}
			if err != nil || result.Status != "deferred" || len(result.Descriptor) != 0 {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestAuthenticatedDiscoveryPersistsAdmissionBeforeDelivery(t *testing.T) {
	state, v := rememberedFixture(t)
	schedule, cache := discoveryDirs(t)
	r := fixture(t)
	r.body = v.Release
	r.publish(t, 1)
	session := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
	result, err := session.RunAdmitted(schedule, cache, state, r.root, baseURL, v.Device, v.Policy, 0)
	if err != nil || result.Status != "admitted" || result.Admission.Decision != "eligible" || !bytes.Equal(result.Descriptor, v.Release) {
		t.Fatalf("%+v %v", result, err)
	}
	saved, err := readAdmission(state)
	if err != nil || saved.Lanes["stable"].Sequence != 2 {
		t.Fatal("admission not durable before exposure", err)
	}
	r.body = mutateAdmission(t, v.Release, func(d map[string]any) {
		d["rollout"].(map[string]any)["paused"] = true
		d["rollout"].(map[string]any)["revision"] = 2
	})
	r.publish(t, 2)
	later := now.UnixMilli() + 31000
	session = &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{later, later}}, transport: &discoveryFixture{repository: r}}
	result, err = session.RunAdmitted(schedule, cache, state, r.root, baseURL, v.Device, v.Policy, 2)
	if err != nil || result.Status != "deferred" || result.Admission.Reason != "rollout-paused" || len(result.Descriptor) != 0 {
		t.Fatalf("paused result exposed: %+v %v", result, err)
	}
	saved, err = readAdmission(state)
	if err != nil || saved.Lanes["stable"].Revision != 2 {
		t.Fatal("pause revision not persisted", err)
	}
}

func TestAdmissionStorageFailureSchedulesFailureNotSuccess(t *testing.T) {
	state, v := rememberedFixture(t)
	schedule, cache := discoveryDirs(t)
	r := fixture(t)
	r.body = v.Release
	r.publish(t, 1)
	if err := os.WriteFile(state+"/admission.json", []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	session := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
	result, err := session.RunAdmitted(schedule, cache, state, r.root, baseURL, v.Device, v.Policy, 0)
	if err == nil || result != nil {
		t.Fatal("persistence failure exposed update")
	}
	saved, err := readDiscovery(schedule)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Failures != 1 || saved.Lease != "" || saved.Next > now.UnixMilli()+120000 {
		t.Fatalf("admission failure recorded as successful check: %+v", saved)
	}
}

func TestDiscoveryRejectsInvalidPolicyBeforeNetwork(t *testing.T) {
	v := admissionVectors(t)[0]
	for _, prepare := range []bool{false, true} {
		for _, mutation := range []func(map[string]any){
			func(p map[string]any) { p["trustedLowerMs"] = 0 },
			func(p map[string]any) { p["trustedUpperMs"] = 1 },
			func(p map[string]any) { delete(p, "trustedUpperMs") },
			func(p map[string]any) { p["minimumSequence"] = 0 },
		} {
			transport := &discoveryFixture{repository: fixture(t), hook: func() { t.Fatal("invalid policy performed network I/O") }}
			session := &discoverySession{transport: transport, source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}}
			policy := mutateAdmission(t, v.Policy, mutation)
			var err error
			if prepare {
				_, err = session.RunPrepared("", "", "", "", transport.root, baseURL, v.Device, policy, 0)
			} else {
				_, err = session.RunAdmitted("", "", "", transport.root, baseURL, v.Device, policy, 0)
			}
			session.Close()
			if err == nil {
				t.Fatal("invalid policy accepted")
			}
		}
	}
}
