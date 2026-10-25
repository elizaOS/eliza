package otatrust

import "testing"

func TestIntervalScheduleUsesConservativeBounds(t *testing.T) {
	dir := privateDir(t)
	n := now.UnixMilli()
	claim, err := BeginStagingInterval(dir, n, n+1000, 0)
	if err != nil || claim.Token == "" {
		t.Fatalf("%+v %v", claim, err)
	}
	finished, err := FinishStagingInterval(dir, claim.Token, n+10, n+2000, true, 60000)
	if err != nil {
		t.Fatal(err)
	}
	if finished.DelayMillis != 61990 {
		t.Fatalf("server delay started too early: %+v", finished)
	}
	state, err := readDiscovery(dir)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastTime != n+10 || state.NotBefore != n+62000 {
		t.Fatalf("wrong floor/deadline: %+v", state)
	}
	// Upper alone crossing the deadline is insufficient to issue another claim.
	blocked, err := BeginStagingInterval(dir, n+61999, n+63000, 0)
	if err != nil || blocked.Token != "" || blocked.DelayMillis != 1 {
		t.Fatalf("early claim: %+v %v", blocked, err)
	}
	ready, err := BeginStagingInterval(dir, n+62000, n+63000, 0)
	if err != nil || ready.Token == "" {
		t.Fatalf("due claim missing: %+v %v", ready, err)
	}
}

func TestIntervalScheduleNarrowsOverlapWithoutPoisoningFloor(t *testing.T) {
	dir := privateDir(t)
	n := now.UnixMilli()
	claim, err := BeginDiscoveryInterval(dir, n, n+1000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = FinishDiscoveryInterval(dir, claim.Token, n-100, n+500, true, 0); err != nil {
		t.Fatal(err)
	}
	state, err := readDiscovery(dir)
	if err != nil || state.LastTime != n {
		t.Fatalf("floor changed: %+v %v", state, err)
	}
	if _, err = BeginDiscoveryInterval(dir, n-200, n-1, 0); err == nil {
		t.Fatal("wholly older interval accepted")
	}
	// Existing exact-time callers can read the same durable state.
	if _, err = BeginDiscoveryInterval(dir, n, n, 0); err != nil {
		t.Fatal(err)
	}
}

func TestIntervalScheduleLeaseBoundaryAndInvalidBounds(t *testing.T) {
	dir := privateDir(t)
	n := now.UnixMilli()
	claim, err := BeginDiscoveryInterval(dir, n, n+1000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = FinishDiscoveryInterval(dir, claim.Token, n+1, n+1000+leaseMillis, true, 0); err == nil {
		t.Fatal("possibly expired lease accepted")
	}
	state, err := readDiscovery(dir)
	if err != nil || state.Lease != claim.Token {
		t.Fatalf("failed completion lost claim: %+v %v", state, err)
	}
	if _, err = BeginDiscoveryInterval(dir, n+2, n+1, 0); err == nil {
		t.Fatal("reversed bounds accepted")
	}
	if _, err = FinishStagingInterval(dir, claim.Token, 0, n, false, 0); err == nil {
		t.Fatal("invalid staging bounds accepted")
	}
}
