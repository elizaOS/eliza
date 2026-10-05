package otatrust

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func preparedFixture(t *testing.T) (string, string, string, admissionVector) {
	t.Helper()
	state, v := rememberedFixture(t)
	directory := privateDir(t)
	schedule, cache := discoveryDirs(t)
	r := fixture(t)
	r.body = v.Release
	r.publish(t, 1)
	session := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
	result, err := session.RunPrepared(schedule, cache, state, directory, r.root, baseURL, v.Device, v.Policy, 0)
	if err != nil || result.Status != "admitted" || !validHex(result.AuthorizationID) {
		t.Fatalf("prepared result %+v %v", result, err)
	}
	return directory, state, result.AuthorizationID, v
}
func loadRecovery(dir, state, id string) (*RecoveryMaterial, error) {
	return LoadRecoveryAuthorization(dir, state, id, strings.Repeat("b", 64), 2, strings.Repeat("c", 64), 3, strings.Repeat("d", 64), 1)
}
func TestPreparedRecoveryReopensWithoutNetworkOrClock(t *testing.T) {
	directory, state, id, v := preparedFixture(t)
	material, err := loadRecovery(directory, state, id)
	if err != nil {
		t.Fatal(err)
	}
	var recovery releaseArtifact
	if err = json.Unmarshal(material.Artifact, &recovery); err != nil {
		t.Fatal(err)
	}
	if recovery.SHA256 != strings.Repeat("c", 64) || recovery.VersionCode != 3 || material.Distribution != "launcher" {
		t.Fatal("wrong recovery material")
	}
	var device admissionDevice
	var policy admissionPolicy
	json.Unmarshal(v.Device, &device)
	json.Unmarshal(v.Policy, &policy)
	same, err := persistPreparedAuthorization(directory, v.Release, device, policy, 0)
	if err != nil || same != id {
		t.Fatal("idempotent preparation failed", err)
	}
	// Re-reading needs neither server availability nor metadata re-authentication;
	// it is only a local permit for the exact committed candidate/recovery pair.
	material, err = loadRecovery(directory, state, id)
	if err != nil || len(material.Artifact) == 0 {
		t.Fatal(err)
	}
}
func TestPreparedRecoveryRejectsMismatchesAndCorruption(t *testing.T) {
	for _, mode := range []string{"candidate", "recovery", "signer", "floor", "corrupt", "symlink", "lost-policy"} {
		t.Run(mode, func(t *testing.T) {
			dir, state, id, _ := preparedFixture(t)
			candidate, recovery, signer := strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64)
			floor := int64(1)
			switch mode {
			case "candidate":
				candidate = strings.Repeat("a", 64)
			case "recovery":
				recovery = strings.Repeat("e", 64)
			case "signer":
				signer = strings.Repeat("a", 64)
			case "floor":
				floor = 2
			case "corrupt":
				os.WriteFile(filepath.Join(dir, id+".json"), []byte("{}"), 0600)
			case "symlink":
				os.Remove(filepath.Join(dir, id+".json"))
				os.Symlink("absent", filepath.Join(dir, id+".json"))
			case "lost-policy":
				os.Remove(filepath.Join(state, "admission.json"))
			}
			if result, err := LoadRecoveryAuthorization(dir, state, id, candidate, 2, recovery, 3, signer, floor); err == nil || result != nil {
				t.Fatal("unsafe recovery allowed")
			}
		})
	}
}
func TestPreparedRecoveryHonorsLaterRevocations(t *testing.T) {
	for _, target := range []string{"b", "c"} {
		t.Run(target, func(t *testing.T) {
			dir, state, id, v := preparedFixture(t)
			newer := mutateAdmission(t, v.Release, func(r map[string]any) {
				rollout := r["rollout"].(map[string]any)
				rollout["revision"] = 2
				rollout["revokedSha256"] = []string{strings.Repeat(target, 64)}
			})
			if result, err := EvaluateRememberedReleaseInterval(state, newer, v.Device, v.Policy); err != nil || result.Reason != "revoked-artifact" {
				t.Fatalf("%+v %v", result, err)
			}
			result, err := loadRecovery(dir, state, id)
			if target == "b" {
				if err != nil || result == nil {
					t.Fatal("revoked candidate cannot escape to authorized recovery", err)
				}
			} else if err == nil || result != nil {
				t.Fatal("revoked recovery allowed")
			}
		})
	}
}
func TestPreparedPersistenceFailureRetries(t *testing.T) {
	state, v := rememberedFixture(t)
	directory := privateDir(t)
	os.Symlink("absent", filepath.Join(directory, "prepared.tmp"))
	schedule, cache := discoveryDirs(t)
	r := fixture(t)
	r.body = v.Release
	r.publish(t, 1)
	session := &discoverySession{source: &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}}, transport: &discoveryFixture{repository: r}}
	if result, err := session.RunPrepared(schedule, cache, state, directory, r.root, baseURL, v.Device, v.Policy, 0); err == nil || result != nil {
		t.Fatal("unpersisted authorization exposed")
	}
	saved, err := readDiscovery(schedule)
	if err != nil || saved.Failures != 1 {
		t.Fatal("persistence failure not retried", err)
	}
}
func TestPreparedAuthorizationKilledWriter(t *testing.T) {
	if dir := os.Getenv("OTA_PREPARED_KILL_DIR"); dir != "" {
		record, err := readPrepared(dir, os.Getenv("OTA_PREPARED_BASE"))
		if err != nil {
			t.Fatal(err)
		}
		record.Generation++
		id, err := admissionHash(record)
		if err != nil {
			t.Fatal(err)
		}
		err = writePrepared(dir, filepath.Join(dir, id+".json"), *record, func(point string) {
			if point == os.Getenv("OTA_PREPARED_KILL_POINT") {
				os.Exit(44)
			}
		})
		t.Fatalf("boundary missed %v", err)
	}
	for _, point := range []string{"before-sync", "before-rename", "published"} {
		t.Run(point, func(t *testing.T) {
			dir, state, id, _ := preparedFixture(t)
			record, err := readPrepared(dir, id)
			if err != nil {
				t.Fatal(err)
			}
			record.Generation++
			next, _ := admissionHash(record)
			child := exec.Command(os.Args[0], "-test.run=^TestPreparedAuthorizationKilledWriter$")
			child.Env = append(os.Environ(), "OTA_PREPARED_KILL_DIR="+dir, "OTA_PREPARED_BASE="+id, "OTA_PREPARED_KILL_POINT="+point)
			err = child.Run()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 44 {
				t.Fatalf("child: %v", err)
			}
			if _, err = loadRecovery(dir, state, id); err != nil {
				t.Fatal("active recovery overwritten", err)
			}
			_, err = readPrepared(dir, next)
			if point == "published" && err != nil {
				t.Fatal(err)
			}
			if point != "published" && err == nil {
				t.Fatal("partial authorization published")
			}
		})
	}
}

func TestPreparedPairBindsJournalScopeAndArtifacts(t *testing.T) {
	dir, _, id, _ := preparedFixture(t)
	record, err := readPrepared(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	candidate, _ := json.Marshal(record.Descriptor.Candidate)
	recovery, _ := json.Marshal(record.Descriptor.Recovery)
	if err = VerifyPreparedPair(dir, id, record.Baseline, record.BaselineVersion, 0, "stable", "launcher", candidate, recovery); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"baseline", "generation", "channel", "distribution", "artifact"} {
		t.Run(mode, func(t *testing.T) {
			baseline := record.Baseline
			generation := int64(0)
			channel, distribution := "stable", "launcher"
			candidateInput := candidate
			switch mode {
			case "baseline":
				baseline = strings.Repeat("e", 64)
			case "generation":
				generation = 1
			case "channel":
				channel = "beta"
			case "distribution":
				distribution = "standalone"
			case "artifact":
				candidateInput = recovery
			}
			if err := VerifyPreparedPair(dir, id, baseline, record.BaselineVersion, generation, channel, distribution, candidateInput, recovery); err == nil {
				t.Fatal("unbound commit accepted")
			}
		})
	}
}
