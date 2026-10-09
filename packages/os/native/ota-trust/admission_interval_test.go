package otatrust

import (
	"bytes"
	"encoding/json"
	"testing"
)

func intervalPolicyFor(t *testing.T, original []byte, lower, upper int64) []byte {
	t.Helper()
	return mutateAdmission(t, original, func(p map[string]any) {
		p["trustedLowerMs"] = lower
		p["trustedUpperMs"] = upper
	})
}

func TestIntervalAdmissionRolloutBoundaries(t *testing.T) {
	v := admissionVectors(t)[0]
	var d releaseDescriptor
	if err := decodeAdmission(v.Release, &d); err != nil {
		t.Fatal(err)
	}
	start, _ := releaseTime(d.Rollout.Starts)
	expires, _ := releaseTime(d.Rollout.Expires)
	for _, tc := range []struct {
		name         string
		lower, upper int64
		eligible     bool
	}{
		{"exact-start", start, start, true},
		{"whole-window", start, expires - 1, true},
		{"before-start", start - 2, start - 1, false},
		{"straddles-start", start - 1, start + 1, false},
		{"upper-at-start", start - 1, start, false},
		{"before-expiry", expires - 1, expires - 1, true},
		{"upper-at-expiry", start, expires, false},
		{"straddles-expiry", expires - 1, expires + 1, false},
		{"exact-expiry", expires, expires, false},
		{"after-expiry", expires + 1, expires + 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := EvaluateReleaseInterval(v.Release, v.Device, intervalPolicyFor(t, v.Policy, tc.lower, tc.upper))
			if err != nil || result == nil {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if tc.eligible {
				if result.Decision != "eligible" {
					t.Fatalf("unexpected deferral: %+v", result)
				}
			} else if result.Decision != "defer" || result.Reason != "rollout-time" {
				t.Fatalf("unsafe time accepted: %+v", result)
			}
		})
	}
}

func TestIntervalAdmissionInvalidInputCannotRatchet(t *testing.T) {
	dir, v := rememberedFixture(t)
	before, err := readAdmission(dir)
	if err != nil {
		t.Fatal(err)
	}
	beforeBytes, _ := json.Marshal(before)
	valid := intervalPolicyFor(t, v.Policy, 100, 200)
	bad := [][]byte{}
	for _, mutation := range []func(map[string]any){
		func(p map[string]any) { delete(p, "trustedLowerMs") },
		func(p map[string]any) { delete(p, "trustedUpperMs") },
		func(p map[string]any) { p["trustedNowMs"] = 150 },
		func(p map[string]any) { p["trustedLowerMs"] = 0 },
		func(p map[string]any) { p["trustedLowerMs"] = 201 },
		func(p map[string]any) { p["trustedUpperMs"] = -1 },
		func(p map[string]any) { p["trustedUpperMs"] = nil },
		func(p map[string]any) { p["trustedUpperMs"] = "200" },
		func(p map[string]any) { p["trustedUpperMs"] = safeInteger + 1 },
	} {
		bad = append(bad, mutateAdmission(t, valid, mutation))
	}
	bad = append(bad, bytes.Replace(valid, []byte(`"trustedUpperMs":200`), []byte(`"trustedUpperMs":200,"trustedUpperMs":200`), 1))
	for i, p := range bad {
		if result, err := EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, p); err == nil || result != nil {
			t.Fatalf("invalid interval %d accepted: %+v %v", i, result, err)
		}
		after, err := readAdmission(dir)
		if err != nil {
			t.Fatal(err)
		}
		afterBytes, _ := json.Marshal(after)
		if !bytes.Equal(beforeBytes, afterBytes) {
			t.Fatalf("invalid interval %d mutated durable admission", i)
		}
	}
}

func TestIntervalAdmissionRememberedDeferralAndReplay(t *testing.T) {
	dir, v := rememberedFixture(t)
	var d releaseDescriptor
	if err := decodeAdmission(v.Release, &d); err != nil {
		t.Fatal(err)
	}
	start, _ := releaseTime(d.Rollout.Starts)
	expires, _ := releaseTime(d.Rollout.Expires)
	newRelease := mutateAdmission(t, v.Release, func(p map[string]any) { p["sequence"] = d.Sequence + 1 })
	// Even while time prevents installation, authenticated policy advances the
	// remembered sequence. A later narrower interval must not permit replay.
	result, err := EvaluateRememberedReleaseInterval(dir, newRelease, v.Device, intervalPolicyFor(t, v.Policy, start, expires))
	if err != nil || result.Decision != "defer" || result.Reason != "rollout-time" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	state, err := readAdmission(dir)
	if err != nil || state.Lanes["stable"].Sequence != d.Sequence+1 {
		t.Fatalf("missing durable ratchet: %+v %v", state, err)
	}
	result, err = EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, intervalPolicyFor(t, v.Policy, start, start))
	if err != nil || result.Decision != "defer" || result.Reason != "metadata-rollback" {
		t.Fatalf("replay admitted: %+v %v", result, err)
	}
	result, err = EvaluateRememberedReleaseInterval(dir, newRelease, v.Device, intervalPolicyFor(t, v.Policy, start, start))
	if err != nil || result.Decision != "eligible" {
		t.Fatalf("valid narrower time failed: %+v %v", result, err)
	}
}
