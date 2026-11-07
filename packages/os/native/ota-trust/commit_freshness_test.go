package otatrust

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func commitPolicyJSON(t *testing.T, lower, upper, floor, refreshedAfter int64) []byte {
	t.Helper()
	return commitByPolicyJSON(t, lower, upper, floor, refreshedAfter, 0)
}

func commitByPolicyJSON(t *testing.T, lower, upper, floor, refreshedAfter, commitBy int64) []byte {
	t.Helper()
	data, err := json.Marshal(commitPolicy{Lower: lower, Upper: upper, SecurityFloor: floor, RefreshedAfter: refreshedAfter, CommitBy: commitBy})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func commitDecisionFor(t *testing.T, dir, state, id string, lower, upper, floor, refreshedAfter int64) string {
	t.Helper()
	decision, err := EvaluatePreparedForCommit(dir, state, id, commitPolicyJSON(t, lower, upper, floor, refreshedAfter))
	if err != nil {
		t.Fatal(err)
	}
	return decision
}

func TestCommitFreshnessEligibleControl(t *testing.T) {
	dir, state, id, _ := preparedFixture(t)
	at := now.UnixMilli()
	if decision := commitDecisionFor(t, dir, state, id, at, at, 1, at); decision != "eligible" {
		t.Fatal(decision)
	}
}

// The whole trusted interval must fit the rollout window, as at admission.
func TestCommitFreshnessRejectsRolloutTime(t *testing.T) {
	dir, state, id, _ := preparedFixture(t)
	expires := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	starts := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if decision := commitDecisionFor(t, dir, state, id, expires-1, expires, 1, 0); decision != "expired" {
		t.Fatal("interval straddling expiry:", decision)
	}
	if decision := commitDecisionFor(t, dir, state, id, starts-1, starts, 1, 0); decision != "rollout-time" {
		t.Fatal("interval straddling start:", decision)
	}
}

// Revocations the device already stores apply at commit. The prepared pair
// binding alone does not see them.
func TestCommitFreshnessRejectsDurableRevocation(t *testing.T) {
	for _, digest := range []string{"b", "c"} {
		t.Run(digest, func(t *testing.T) {
			dir, state, id, v := preparedFixture(t)
			revoking := mutateAdmission(t, v.Release, func(r map[string]any) {
				rollout := r["rollout"].(map[string]any)
				rollout["revision"] = 2
				rollout["revokedSha256"] = []string{strings.Repeat(digest, 64)}
			})
			if _, err := EvaluateRememberedReleaseInterval(state, revoking, v.Device, v.Policy); err != nil {
				t.Fatal(err)
			}
			at := now.UnixMilli()
			if decision := commitDecisionFor(t, dir, state, id, at, at, 1, 0); decision != "revoked-artifact" {
				t.Fatal(decision)
			}
		})
	}
}

func TestCommitFreshnessRejectsFloorAndNewerSequence(t *testing.T) {
	dir, state, id, v := preparedFixture(t)
	at := now.UnixMilli()
	if decision := commitDecisionFor(t, dir, state, id, at, at, 2, 0); decision != "below-security-floor" {
		t.Fatal(decision)
	}
	newer := mutateAdmission(t, v.Release, func(r map[string]any) { r["sequence"] = 3 })
	if _, err := EvaluateRememberedReleaseInterval(state, newer, v.Device, v.Policy); err != nil {
		t.Fatal(err)
	}
	if decision := commitDecisionFor(t, dir, state, id, at, at, 1, 0); decision != "superseded" {
		t.Fatal(decision)
	}
}

// Only a fetch records a refresh. Re-evaluating the stored descriptor later,
// as staging and admission do, leaves the metadata stale.
func TestCommitFreshnessRequiresAFetchedRefresh(t *testing.T) {
	f := enrolledTest(t)
	result, err := f.run()
	if err != nil || result.Status != "admitted" {
		t.Fatalf("%+v %v", result, err)
	}
	id := result.AuthorizationID
	later := now.Add(30 * time.Minute).UnixMilli()
	var policy admissionPolicy
	if err = json.Unmarshal(admissionVectors(t)[0].Policy, &policy); err != nil {
		t.Fatal(err)
	}
	policy.Lower, policy.Upper = later, later
	stored, _ := json.Marshal(policy)
	record, err := readPrepared(f.prepared, id)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, _ := json.Marshal(record.Descriptor)
	if _, err = EvaluateRememberedReleaseInterval(f.admission, descriptor, f.device, stored); err != nil {
		t.Fatal(err)
	}
	if decision := commitDecisionFor(t, f.prepared, f.admission, id, later, later, 1, later); decision != "stale-metadata" {
		t.Fatal("stored bytes counted as a refresh:", decision)
	}
	before, _ := os.ReadDir(f.prepared)
	refresh, err := newEnrolledDiscovery(f.directory, func(string) (discoveryTransport, error) {
		return &discoveryFixture{repository: f.transport.repository}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	refresh.session.source = &fixtureTimeSource{bounds: TrustedTimeInterval{later, later}}
	schedule, _ := discoveryDirs(t)
	refreshed, err := refresh.RefreshWithTimeSource(schedule, f.cache, f.admission, f.device, 1, 0)
	if err != nil || refreshed.Status != "admitted" || refreshed.Descriptor != nil || refreshed.AuthorizationID != "" {
		t.Fatalf("refresh %+v %v", refreshed, err)
	}
	if after, _ := os.ReadDir(f.prepared); len(after) != len(before) {
		t.Fatal("refresh wrote a prepared record")
	}
	if decision := commitDecisionFor(t, f.prepared, f.admission, id, later, later, 1, later); decision != "eligible" {
		t.Fatal("refresh not recorded:", decision)
	}
	if decision := commitDecisionFor(t, f.prepared, f.admission, id, later, later, 1, later+1); decision != "stale-metadata" {
		t.Fatal("refresh counted as newer than it was:", decision)
	}
}

// commitByUpperMs bounds the time from the run's refresh to its commit. An
// activation run that outlives it is refused, so a revocation published while
// it waited cannot be missed for longer than the bound.
func TestCommitFreshnessRefusesALongActivationRun(t *testing.T) {
	dir, state, id, _ := preparedFixture(t)
	at := now.UnixMilli()
	if decision := commitDecisionFor(t, dir, state, id, at, at, 1, 0); decision != "eligible" {
		t.Fatal(decision)
	}
	decide := func(upper, commitBy int64) string {
		t.Helper()
		decision, err := EvaluatePreparedForCommit(dir, state, id, commitByPolicyJSON(t, at, upper, 1, 0, commitBy))
		if err != nil {
			t.Fatal(err)
		}
		return decision
	}
	if decision := decide(at, at); decision != "eligible" {
		t.Fatal("commit at the bound refused:", decision)
	}
	if decision := decide(at+1, at); decision != "stale-metadata" {
		t.Fatal("commit after the bound accepted:", decision)
	}
	if decision := decide(at+1, 0); decision != "eligible" {
		t.Fatal("no bound refused:", decision)
	}
}

func TestCommitFreshnessRefusesBadInputsAndLostState(t *testing.T) {
	dir, state, id, _ := preparedFixture(t)
	at := now.UnixMilli()
	for _, policy := range [][]byte{commitPolicyJSON(t, 0, at, 1, 0), commitPolicyJSON(t, at, at-1, 1, 0), commitPolicyJSON(t, at, at, 0, 0), commitByPolicyJSON(t, at, at, 1, 0, -1), []byte(`{"trustedLowerMs":1}`)} {
		if _, err := EvaluatePreparedForCommit(dir, state, id, policy); err == nil {
			t.Fatalf("invalid policy accepted: %s", policy)
		}
	}
	if err := os.Remove(state + "/admission.json"); err != nil {
		t.Fatal(err)
	}
	if decision, err := EvaluatePreparedForCommit(dir, state, id, commitPolicyJSON(t, at, at, 1, 0)); err == nil || decision != "" {
		t.Fatal("lost admission state decided", decision)
	}
}

// A refresh's success must not hold back the next refresh: each activation run
// refreshes and then commits, so a refresh deferred by an earlier success
// would leave every run stale. Runs a minute and 20 minutes apart (the fixture
// timestamp lasts an hour) each fetch and each reach eligible.
func TestCommitFreshnessRefreshesEveryActivationRun(t *testing.T) {
	f := enrolledTest(t)
	result, err := f.run()
	if err != nil || result.Status != "admitted" {
		t.Fatalf("%+v %v", result, err)
	}
	id := result.AuthorizationID
	schedule, _ := discoveryDirs(t)
	const maxRun = 10 * 60 * 1000
	start := now.Add(5 * time.Minute)
	for _, gap := range []time.Duration{0, time.Minute, 20 * time.Minute} {
		at := start.Add(gap).UnixMilli()
		refresh, err := newEnrolledDiscovery(f.directory, func(string) (discoveryTransport, error) {
			return &discoveryFixture{repository: f.transport.repository}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		refresh.session.source = &fixtureTimeSource{bounds: TrustedTimeInterval{at, at}}
		refreshed, err := refresh.RefreshWithTimeSource(schedule, f.cache, f.admission, f.device, 1, 0)
		if err != nil || refreshed.Status != "admitted" {
			t.Fatalf("run after %v: refresh %+v %v", gap, refreshed, err)
		}
		state, err := readAdmission(f.admission)
		if err != nil || state.Lanes["stable"].Refreshed != at {
			t.Fatalf("run after %v: refresh not recorded %+v %v", gap, state, err)
		}
		decision, err := EvaluatePreparedForCommit(f.prepared, f.admission, id, commitByPolicyJSON(t, at, at, 1, at, at+maxRun))
		if err != nil || decision != "eligible" {
			t.Fatalf("run after %v: commit %q %v", gap, decision, err)
		}
	}
}
