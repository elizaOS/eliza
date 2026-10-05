package otatrust

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func rememberedFixture(t *testing.T) (string, admissionVector) {
	t.Helper()
	dir := privateDir(t)
	v := admissionVectors(t)[0]
	if err := InitializeAdmissionState(dir, "eliza-research/senior-care", "launcher"); err != nil {
		t.Fatal(err)
	}
	return dir, v
}
func mutateAdmission(t *testing.T, data []byte, change func(map[string]any)) []byte {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	change(value)
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestRememberedAdmissionRejectsRollbackAndEquivocation(t *testing.T) {
	dir, v := rememberedFixture(t)
	run := func(data []byte) (*AdmissionResult, error) {
		return EvaluateRememberedReleaseInterval(dir, data, v.Device, v.Policy)
	}
	if result, err := run(v.Release); err != nil || result.Decision != "eligible" {
		t.Fatalf("%+v %v", result, err)
	}
	// Same semantic JSON is permitted even with different whitespace/key order.
	reordered := mutateAdmission(t, v.Release, func(map[string]any) {})
	if _, err := run(reordered); err != nil {
		t.Fatal(err)
	}
	changed := mutateAdmission(t, v.Release, func(r map[string]any) { r["releaseId"] = "different" })
	if result, err := run(changed); err == nil || result != nil {
		t.Fatal("sequence reused for other code")
	}
	changed = mutateAdmission(t, v.Release, func(r map[string]any) { r["rollout"].(map[string]any)["paused"] = true })
	if _, err := run(changed); err == nil {
		t.Fatal("same rollout revision mutated")
	}
	paused := mutateAdmission(t, changed, func(r map[string]any) { r["rollout"].(map[string]any)["revision"] = 2 })
	if result, err := run(paused); err != nil || result.Reason != "rollout-paused" {
		t.Fatalf("%+v %v", result, err)
	}
	if result, err := run(v.Release); err != nil || result.Reason != "metadata-rollback" {
		t.Fatalf("old policy admitted: %+v %v", result, err)
	}
	if err := InitializeAdmissionState(dir, "eliza-research/senior-care", "launcher"); err == nil {
		t.Fatal("state reset allowed")
	}
}
func TestRememberedAdmissionChannelsAndSecurity(t *testing.T) {
	dir, v := rememberedFixture(t)
	beta := mutateAdmission(t, v.Release, func(r map[string]any) {
		r["channel"] = "beta"
		r["sequence"] = 20
		r["securityFloor"] = 2
		for _, k := range []string{"candidate", "recovery"} {
			r[k].(map[string]any)["securityEpoch"] = 2
		}
	})
	device := mutateAdmission(t, v.Device, func(d map[string]any) { d["requestedChannel"] = "beta" })
	if result, err := EvaluateRememberedReleaseInterval(dir, beta, device, v.Policy); err != nil || result.Decision != "eligible" {
		t.Fatalf("%+v %v", result, err)
	}
	if result, err := EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, v.Policy); err != nil || result.Decision != "eligible" {
		t.Fatalf("Beta changed Stable authority: %+v %v", result, err)
	}
	lower := mutateAdmission(t, v.Release, func(r map[string]any) { r["channel"] = "beta"; r["sequence"] = 21 })
	if result, err := EvaluateRememberedReleaseInterval(dir, lower, device, v.Policy); err != nil || result.Reason != "security-floor" {
		t.Fatalf("%+v %v", result, err)
	}
}
func TestRememberedAdmissionMissingCorruptAndWrongEnrollment(t *testing.T) {
	for _, mode := range []string{"missing", "corrupt", "symlink", "repository", "distribution", "invalid-observation"} {
		t.Run(mode, func(t *testing.T) {
			dir, v := rememberedFixture(t)
			if _, err := EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, v.Policy); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing":
				os.Remove(filepath.Join(dir, "admission.json"))
			case "corrupt":
				os.WriteFile(filepath.Join(dir, "admission.json"), []byte("{}"), 0600)
			case "symlink":
				os.Remove(filepath.Join(dir, "admission.json"))
				os.Symlink("other", filepath.Join(dir, "admission.json"))
			case "repository":
				v.Policy = mutateAdmission(t, v.Policy, func(p map[string]any) { p["repository"] = "another/repo" })
			case "distribution":
				v.Device = mutateAdmission(t, v.Device, func(p map[string]any) { p["distribution"] = "standalone" })
			case "invalid-observation":
				v.Policy = mutateAdmission(t, v.Policy, func(p map[string]any) { p["minimumSequence"] = 0 })
			}
			if result, err := EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, v.Policy); err == nil || result != nil {
				t.Fatal("invalid persistent authority accepted")
			}
		})
	}
}
func TestAdmissionKilledWriter(t *testing.T) {
	if dir := os.Getenv("OTA_ADMISSION_KILL_DIR"); dir != "" {
		state, err := readAdmission(dir)
		if err != nil {
			t.Fatal(err)
		}
		f := state.Lanes["stable"]
		f.Revision = 2
		state.Lanes["stable"] = f
		err = saveAdmission(dir, *state, func(point string) {
			if point == os.Getenv("OTA_ADMISSION_KILL_POINT") {
				os.Exit(43)
			}
		})
		t.Fatalf("death boundary missed: %v", err)
	}
	for _, point := range []string{"before-sync", "before-rename", "published"} {
		t.Run(point, func(t *testing.T) {
			dir, v := rememberedFixture(t)
			if _, err := EvaluateRememberedReleaseInterval(dir, v.Release, v.Device, v.Policy); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestAdmissionKilledWriter$")
			child.Env = append(os.Environ(), "OTA_ADMISSION_KILL_DIR="+dir, "OTA_ADMISSION_KILL_POINT="+point)
			err := child.Run()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 43 {
				t.Fatalf("child: %v", err)
			}
			state, err := readAdmission(dir)
			if err != nil {
				t.Fatal(err)
			}
			want := int64(1)
			if point == "published" {
				want = 2
			}
			if state.Lanes["stable"].Revision != want {
				t.Fatal("torn admission state")
			}
		})
	}
}

func TestRememberedRevocationsCannotDisappear(t *testing.T) {
	dir, v := rememberedFixture(t)
	revoked := mutateAdmission(t, v.Release, func(r map[string]any) {
		r["rollout"].(map[string]any)["revokedSha256"] = []string{"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
	})
	if result, err := EvaluateRememberedReleaseInterval(dir, revoked, v.Device, v.Policy); err != nil || result.Reason != "revoked-artifact" {
		t.Fatalf("%+v %v", result, err)
	}
	cleared := mutateAdmission(t, v.Release, func(r map[string]any) { r["rollout"].(map[string]any)["revision"] = 2 })
	if result, err := EvaluateRememberedReleaseInterval(dir, cleared, v.Device, v.Policy); err == nil || result != nil {
		t.Fatal("revoked recovery silently reenabled")
	}
}
