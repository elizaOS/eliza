package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"tailscale.com/ipn"
)

func TestRemoteStateSurvivesClientRestartAndPreservesBinaryIdentity(t *testing.T) {
	var mu sync.Mutex
	values := map[string][]byte{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			w.WriteHeader(401)
			return
		}
		var request struct {
			Operation, Key string
			Value          []byte
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if request.Operation == "write" {
			values[request.Key] = request.Value
			w.WriteHeader(204)
			return
		}
		value, exists := values[request.Key]
		if !exists {
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]string{"code": "STATE_NOT_FOUND"})
			return
		}
		json.NewEncoder(w).Encode(map[string][]byte{"value": value})
	}))
	defer server.Close()
	newStore := func() *remoteStateStore {
		s, err := newRemoteStateStore(server.URL, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		s.client.Transport = server.Client().Transport
		return s
	}
	first := newStore()
	if _, err := first.ReadState(ipn.MachineKeyStateKey); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatalf("missing state: %v", err)
	}
	identity := []byte{0, 1, 255, 128, 10}
	if err := first.WriteState(ipn.MachineKeyStateKey, identity); err != nil {
		t.Fatal(err)
	}
	second := newStore()
	actual, err := second.ReadState(ipn.MachineKeyStateKey)
	if err != nil || !bytes.Equal(identity, actual) {
		t.Fatalf("identity did not survive new client: %v", err)
	}
	if err := second.WriteState("empty", []byte{}); err != nil {
		t.Fatal(err)
	}
	empty, err := newStore().ReadState("empty")
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty value: %v", err)
	}
}

func TestRemoteStateFailsClosedWithoutRetryOrSecretDisclosure(t *testing.T) {
	for _, status := range []int{301, 401, 403, 404, 409, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			count := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count++
				w.Header().Set("Location", "https://untrusted.invalid/")
				w.WriteHeader(status)
				w.Write([]byte(`{"secret":"never expose"}`))
			}))
			defer server.Close()
			store, _ := newRemoteStateStore(server.URL, "private-token")
			store.client.Transport = server.Client().Transport
			_, err := store.ReadState("private-key")
			var typed *stateStoreError
			if !errors.As(err, &typed) || errors.Is(err, ipn.ErrStateNotExist) {
				t.Fatalf("failure must not become missing identity: %v", err)
			}
			if err := store.WriteState("private-key", []byte("private-value")); !errors.As(err, &typed) {
				t.Fatalf("write error missing: %v", err)
			}
			if count != 2 {
				t.Fatalf("unexpected retries: %d", count)
			}
		})
	}
}

func TestRemoteStateRejectsUnsafeEndpoints(t *testing.T) {
	for _, endpoint := range []string{"", "http://example.com", "https://user:password@example.com", "https://example.com?token=x", "https://example.com/#fragment"} {
		if _, err := newRemoteStateStore(endpoint, "token"); err == nil {
			t.Fatalf("accepted unsafe endpoint %q", endpoint)
		}
	}
	if _, err := newRemoteStateStore("https://example.com", ""); err == nil {
		t.Fatal("accepted empty token")
	}
}
