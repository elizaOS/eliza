package otatrust

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// A differential test of the real code against a hand port of the
// OtaFreshAdmission TLA+ model's predicates: Decide, Remembered and LoadCheck,
// and the commit and recovery checks of its fixed configuration (recheck,
// required refresh, fix forward), written out below. It does not run the TLA+
// state machine, so an error made the same way in the model port and in the
// code would pass. To check the model's own commit guard, t <= refreshedAt + F,
// every eligible commit with both bounds set must also satisfy it with
// F = commitByUpperMs - refreshedAfterLowerMs. Every ratchet sequence of the
// model's descriptor table runs through the real functions, and each result
// must equal the port's. Sequences of one descriptor run by default and reach
// every refusal; OTA_FRESH_CONFORMANCE=full adds every sequence of two (about
// two minutes).

type freshDesc struct {
	id, lane                 string
	seq, rev, sec, cand, rec int64
	revoked                  []int64
	expires                  int64
	paused, cohort           bool
}

// The model's identities are version codes: installed 1, then C1 R1 C2 R2 C9 R9.
var freshTable = []freshDesc{
	{"a1", "stable", 1, 1, 1, 2, 3, nil, 9, false, true},
	{"a2", "stable", 1, 2, 1, 2, 3, []int64{2}, 9, false, true},
	{"a2x", "stable", 1, 2, 1, 2, 3, []int64{3}, 9, false, true},
	{"a3", "stable", 1, 3, 1, 2, 3, nil, 9, false, true},
	{"e1", "stable", 1, 3, 1, 6, 7, nil, 9, false, true},
	{"b1", "stable", 2, 3, 2, 4, 5, []int64{2}, 9, false, true},
	{"b0", "stable", 2, 3, 2, 4, 5, nil, 9, false, true},
	{"p1", "stable", 3, 4, 2, 4, 5, nil, 9, true, true},
	{"c1", "stable", 2, 3, 2, 4, 5, []int64{3}, 9, false, false},
	{"z1", "beta", 5, 1, 1, 2, 3, nil, 9, false, true},
	{"s1", "stable", 1, 1, 1, 2, 3, nil, 2, false, true},
}

type freshDevice struct {
	channel   string
	installed int64
	q         []int64
}
type freshPolicy struct{ lo, up, sec int64 }

var (
	freshDevices  = []freshDevice{{"stable", 1, nil}, {"stable", 2, nil}, {"stable", 1, []int64{2}}, {"beta", 1, nil}}
	freshPolicies = []freshPolicy{{0, 0, 1}, {0, 0, 2}, {9, 9, 1}, {1, 2, 1}}
	// Descriptors with a prepared record, for the commit and recovery rows.
	freshPrepared = []int{0, 5, 8, 10}
)

// Model times are hours from a fixed origin. Every rollout starts at hour 0.
const freshStarts = 0

func freshMillis(hours int64) int64 {
	return time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC).Add(time.Duration(hours) * time.Hour).UnixMilli()
}

type freshFloor struct {
	seq, rev, sec int64
	core, rollout string
	revoked       []int64
	refreshed     int64
}

func (d freshDesc) core() string { return fmt.Sprint(d.lane, d.seq, d.sec, d.cand, d.rec) }
func (d freshDesc) rollout() string {
	return fmt.Sprint(d.expires, d.rev, d.paused, d.cohort, sortedCodes(d.revoked))
}
func sortedCodes(codes []int64) []int64 { c := slices.Clone(codes); slices.Sort(c); return c }
func subset(a, b []int64) bool {
	for _, x := range a {
		if !slices.Contains(b, x) {
			return false
		}
	}
	return true
}

// modelDecide is the model's Decide; device rows are reduced to the cohort.
func modelDecide(d freshDesc, dev freshDevice, seq, rev, sec int64, pol freshPolicy) (string, string) {
	switch {
	case dev.channel != d.lane:
		return "defer", "channel-mismatch"
	case d.seq < seq || d.rev < rev:
		return "defer", "metadata-rollback"
	case d.paused:
		return "defer", "rollout-paused"
	case pol.lo < freshStarts || pol.up >= d.expires:
		return "defer", "rollout-time"
	case slices.Contains(d.revoked, d.cand) || slices.Contains(d.revoked, d.rec):
		return "defer", "revoked-artifact"
	case d.sec < sec:
		return "defer", "security-floor"
	case slices.Contains(dev.q, d.cand) || slices.Contains(dev.q, d.rec):
		return "defer", "quarantined"
	case d.cand == dev.installed:
		return "already-installed", ""
	case d.cand <= dev.installed:
		return "defer", "await-forward-version"
	case !d.cohort:
		return "defer", "outside-cohort"
	}
	return "eligible", ""
}

// modelRemembered is the model's Remembered, plus the refresh mark that a
// fetched descriptor records when the floor is saved.
func modelRemembered(fl freshFloor, d freshDesc, dev freshDevice, pol freshPolicy, fetched int64) (string, freshFloor, string, string) {
	decision, reason := modelDecide(d, dev, max(1, fl.seq), max(1, fl.rev), max(pol.sec, fl.sec), pol)
	switch {
	case d.lane != dev.channel, d.seq < fl.seq || d.rev < fl.rev || d.sec < fl.sec:
		return "", fl, decision, reason
	case !subset(fl.revoked, d.revoked):
		return "revocation regression", fl, "", ""
	case fl.seq == d.seq && fl.core != d.core():
		return "release sequence equivocation", fl, "", ""
	case fl.seq == d.seq && fl.rev == d.rev && fl.rollout != d.rollout():
		return "rollout revision equivocation", fl, "", ""
	}
	return "", freshFloor{d.seq, d.rev, d.sec, d.core(), d.rollout(), sortedCodes(d.revoked), max(fl.refreshed, fetched)}, decision, reason
}

// modelRecovery is LoadCheck, split into the refusals floors keep for good.
func modelRecovery(d freshDesc, fl freshFloor, global int64) string {
	switch {
	case fl.seq < d.seq || fl.rev < d.rev:
		return "error"
	case slices.Contains(fl.revoked, d.rec):
		return "revoked-artifact"
	case d.sec < max(global, fl.sec):
		return "below-security-floor"
	}
	return "loadable"
}

// modelCommit is CommitOnlyIfFresh of the fixed configuration: the trusted
// interval inside the rollout, neither artifact known revoked, the security
// floor, no newer sequence, a refresh no older than refreshedAfter and, when
// commitBy is set, a commit no later than commitBy.
func modelCommit(d freshDesc, fl freshFloor, pol freshPolicy, refreshedAfter, commitBy int64) string {
	switch {
	case fl.seq < d.seq || fl.rev < d.rev:
		return "error"
	case pol.up >= d.expires:
		return "expired"
	case pol.lo < freshStarts:
		return "rollout-time"
	case slices.Contains(fl.revoked, d.cand) || slices.Contains(fl.revoked, d.rec):
		return "revoked-artifact"
	case d.sec < max(pol.sec, fl.sec):
		return "below-security-floor"
	case fl.seq > d.seq:
		return "superseded"
	case fl.refreshed < refreshedAfter, commitBy > 0 && freshMillis(pol.up) > commitBy:
		return "stale-metadata"
	}
	return "eligible"
}

func freshHex(code int64) string { return fmt.Sprintf("%064x", code) }

type freshFixture struct {
	descriptors, devices, policies [][]byte
	cores, rollouts                map[string]string // real hash -> model key
	prepared                       string
	ids                            map[int]string
	signer                         string
}

func newFreshFixture(t *testing.T) *freshFixture {
	t.Helper()
	v := admissionVectors(t)[0]
	f := &freshFixture{cores: map[string]string{}, rollouts: map[string]string{}, prepared: privateDir(t), ids: map[int]string{}}
	for _, d := range freshTable {
		data := mutateAdmission(t, v.Release, func(r map[string]any) {
			r["releaseId"] = fmt.Sprintf("r-%s-%d-%d-%d-%d", d.lane, d.seq, d.sec, d.cand, d.rec)
			r["channel"], r["sequence"], r["securityFloor"] = d.lane, d.seq, d.sec
			candidate, recovery := r["candidate"].(map[string]any), r["recovery"].(map[string]any)
			candidate["sha256"], candidate["versionCode"], candidate["securityEpoch"] = freshHex(d.cand), d.cand, d.sec
			recovery["sha256"], recovery["versionCode"], recovery["securityEpoch"] = freshHex(d.rec), d.rec, d.sec
			candidate["compatibility"].(map[string]any)["upgradeOrigins"] = []string{freshHex(1), freshHex(2), freshHex(3)}
			recovery["compatibility"].(map[string]any)["upgradeOrigins"] = []string{freshHex(d.cand)}
			r["safety"].(map[string]any)["recoveryForSha256"] = freshHex(d.cand)
			rollout := r["rollout"].(map[string]any)
			rollout["revision"], rollout["paused"] = d.rev, d.paused
			rollout["starts"] = time.UnixMilli(freshMillis(freshStarts)).UTC().Format("2006-01-02T15:04:05.000Z")
			rollout["expires"] = time.UnixMilli(freshMillis(d.expires)).UTC().Format("2006-01-02T15:04:05.000Z")
			revoked := []string{}
			for _, code := range d.revoked {
				revoked = append(revoked, freshHex(code))
			}
			rollout["revokedSha256"] = revoked
			// A threshold of 0 puts every device outside the cohort.
			rollout["threshold"] = 0
			if d.cohort {
				rollout["threshold"] = 10000
			}
		})
		var real releaseDescriptor
		if err := decodeAdmission(data, &real); err != nil {
			t.Fatal(d.id, err)
		}
		rollout := real.Rollout
		real.Rollout = releaseRollout{}
		core, _ := admissionHash(real)
		rolloutHash, _ := admissionHash(rollout)
		f.cores[core], f.rollouts[rolloutHash] = d.core(), d.rollout()
		f.signer = real.Recovery.Signer
		f.descriptors = append(f.descriptors, data)
	}
	for _, dev := range freshDevices {
		f.devices = append(f.devices, mutateAdmission(t, v.Device, func(r map[string]any) {
			q := []string{}
			for _, code := range dev.q {
				q = append(q, freshHex(code))
			}
			r["requestedChannel"], r["installedSha256"], r["installedVersionCode"], r["quarantine"] = dev.channel, freshHex(dev.installed), dev.installed, q
		}))
	}
	for _, pol := range freshPolicies {
		f.policies = append(f.policies, mutateAdmission(t, v.Policy, func(r map[string]any) {
			r["trustedLowerMs"], r["trustedUpperMs"], r["securityFloor"] = freshMillis(pol.lo), freshMillis(pol.up), pol.sec
		}))
	}
	var device admissionDevice
	var policy admissionPolicy
	if err := json.Unmarshal(f.devices[0], &device); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(f.policies[0], &policy); err != nil {
		t.Fatal(err)
	}
	for _, e := range freshPrepared {
		id, err := persistPreparedAuthorization(f.prepared, f.descriptors[e], device, policy, 0)
		if err != nil {
			t.Fatal(freshTable[e].id, err)
		}
		f.ids[e] = id
	}
	return f
}

// lane reads a real lane back as a model floor.
func (f *freshFixture) lane(t *testing.T, directory, channel string) freshFloor {
	t.Helper()
	state, err := readAdmission(directory)
	if err != nil {
		t.Fatal(err)
	}
	real, exists := state.Lanes[channel]
	if !exists {
		return freshFloor{}
	}
	floor := freshFloor{seq: real.Sequence, rev: real.Revision, sec: real.Security, core: f.cores[real.Core], rollout: f.rollouts[real.Rollout], revoked: []int64{}}
	for _, digest := range real.Revoked {
		var code int64
		fmt.Sscanf(digest, "%x", &code)
		floor.revoked = append(floor.revoked, code)
	}
	floor.revoked, floor.refreshed = sortedCodes(floor.revoked), real.Refreshed
	return floor
}

func sameFloor(a, b freshFloor) bool {
	return a.seq == b.seq && a.rev == b.rev && a.sec == b.sec && a.core == b.core && a.rollout == b.rollout && slices.Equal(sortedCodes(a.revoked), sortedCodes(b.revoked)) && a.refreshed == b.refreshed
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	data, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(to, data, 0600); err != nil {
		t.Fatal(err)
	}
}

// copyAdmission copies the admission state and its refresh record, if any.
func copyAdmission(t *testing.T, from, to string) {
	t.Helper()
	copyFile(t, filepath.Join(from, "admission.json"), filepath.Join(to, "admission.json"))
	if _, err := os.Stat(filepath.Join(from, "refreshed.json")); err == nil {
		copyFile(t, filepath.Join(from, "refreshed.json"), filepath.Join(to, "refreshed.json"))
	} else if err = os.Remove(filepath.Join(to, "refreshed.json")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestFreshAdmissionConformance(t *testing.T) {
	f := newFreshFixture(t)
	sequences := [][]int{{}}
	for a := range freshTable {
		sequences = append(sequences, []int{a})
	}
	if os.Getenv("OTA_FRESH_CONFORMANCE") == "full" {
		for a := range freshTable {
			for b := range freshTable {
				sequences = append(sequences, []int{a, b})
			}
		}
	}
	var cases atomic.Int64
	t.Run("sequences", func(t *testing.T) {
		for _, sequence := range sequences {
			t.Run(fmt.Sprint(sequence), func(t *testing.T) {
				t.Parallel()
				cases.Add(f.replay(t, sequence))
			})
		}
	})
	t.Logf("%d sequences, %d cases, 0 differences", len(sequences), cases.Load())
}

// replay folds sequence into a fresh admission state, as discoveries at time 0
// would, then checks every evaluation, recovery and commit row against the model.
func (f *freshFixture) replay(t *testing.T, sequence []int) (cases int64) {
	t.Helper()
	// Prepared records are locked without waiting, so each replay has its own.
	prepared := privateDir(t)
	for _, id := range f.ids {
		copyFile(t, filepath.Join(f.prepared, id+".json"), filepath.Join(prepared, id+".json"))
	}
	fetched := freshMillis(0)
	state := privateDir(t)
	if err := InitializeAdmissionState(state, "example-org/example-app", "launcher"); err != nil {
		t.Fatal(err)
	}
	model := freshFloor{revoked: []int64{}}
	for _, e := range sequence {
		// Each step stands for a discovery: a fetched descriptor at time 0.
		evaluateRememberedRelease(state, f.descriptors[e], f.devices[0], mustPolicy(t, f.policies[0]), fetched)
		_, model, _, _ = modelRemembered(model, freshTable[e], freshDevices[0], freshPolicies[0], fetched)
	}
	if real := f.lane(t, state, "stable"); !sameFloor(real, model) {
		t.Fatalf("%v: fold floor %+v, model %+v", sequence, real, model)
	}
	work := privateDir(t)
	for e, d := range freshTable {
		for dv, dev := range freshDevices {
			for pl, pol := range freshPolicies {
				cases++
				copyAdmission(t, state, work)
				laneFloor := model
				if dev.channel == "beta" {
					laneFloor = freshFloor{revoked: []int64{}}
				}
				wantErr, wantFloor, wantDecision, wantReason := modelRemembered(laneFloor, d, dev, pol, 0)
				result, err := EvaluateRememberedReleaseInterval(work, f.descriptors[e], f.devices[dv], f.policies[pl])
				gotErr, gotDecision, gotReason := "", "", ""
				if err != nil {
					gotErr = err.Error()
				} else {
					gotDecision, gotReason = result.Decision, result.Reason
				}
				gotFloor := f.lane(t, work, dev.channel)
				if gotErr != wantErr || gotDecision != wantDecision || gotReason != wantReason || !sameFloor(gotFloor, wantFloor) {
					t.Fatalf("%v then %s, device %d, policy %d: got %q %s/%s %+v, model %q %s/%s %+v", sequence, d.id, dv, pl, gotErr, gotDecision, gotReason, gotFloor, wantErr, wantDecision, wantReason, wantFloor)
				}
			}
		}
	}
	for _, e := range freshPrepared {
		d := freshTable[e]
		for _, global := range []int64{1, 2} {
			cases++
			want := modelRecovery(d, model, global)
			got, err := EvaluatePreparedRecovery(prepared, state, f.ids[e], freshHex(d.cand), d.cand, freshHex(d.rec), d.rec, f.signer, global)
			if err != nil {
				got = "error"
			}
			_, loadErr := LoadRecoveryAuthorization(prepared, state, f.ids[e], freshHex(d.cand), d.cand, freshHex(d.rec), d.rec, f.signer, global)
			if got != want || (loadErr == nil) != (want == "loadable") {
				t.Fatalf("%v recovery of %s, floor %d: got %s (load %v), model %s", sequence, d.id, global, got, loadErr, want)
			}
		}
		for _, pol := range freshPolicies {
			for _, after := range []int64{0, fetched, freshMillis(1)} {
				for _, by := range []int64{0, freshMillis(1), freshMillis(2)} {
					cases++
					want := modelCommit(d, model, pol, after, by)
					policy, _ := json.Marshal(commitPolicy{Lower: freshMillis(pol.lo), Upper: freshMillis(pol.up), SecurityFloor: pol.sec, RefreshedAfter: after, CommitBy: by})
					got, err := EvaluatePreparedForCommit(prepared, state, f.ids[e], policy)
					if err != nil {
						got = "error"
					}
					if got != want {
						t.Fatalf("%v commit of %s, policy %+v, refreshed after %d, by %d: got %s, model %s", sequence, d.id, pol, after, by, got, want)
					}
					if got == "eligible" && after > 0 && by > 0 && freshMillis(pol.up)-model.refreshed > by-after {
						t.Fatalf("%v commit of %s at %d breaks t <= refreshedAt + F: refreshed %d, F %d", sequence, d.id, pol.up, model.refreshed, by-after)
					}
				}
			}
		}
	}
	return cases
}

func mustPolicy(t *testing.T, data []byte) admissionPolicy {
	t.Helper()
	var policy admissionPolicy
	if err := decodeAdmission(data, &policy); err != nil {
		t.Fatal(err)
	}
	return policy
}
