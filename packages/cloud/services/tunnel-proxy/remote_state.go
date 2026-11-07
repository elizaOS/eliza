package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"tailscale.com/ipn"
)

// remoteStateStore keeps tsnet identity outside an ephemeral container. A failed
// request never falls back to a fresh local identity or retries an uncertain write.
type remoteStateStore struct {
	endpoint string
	token    string
	client   *http.Client
	mu       sync.Mutex
}

type stateStoreError struct {
	operation string
	status    int
}

func (e *stateStoreError) Error() string {
	return fmt.Sprintf("durable tsnet state %s failed (HTTP %d)", e.operation, e.status)
}

func newRemoteStateStore(endpoint, token string) (*remoteStateStore, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return nil, errors.New("tsnet state requires an HTTPS endpoint and token")
	}
	return &remoteStateStore{endpoint: endpoint, token: token, client: &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (s *remoteStateStore) request(operation string, key ipn.StateKey, value []byte) (*http.Response, error) {
	body, err := json.Marshal(struct {
		Operation string `json:"operation"`
		Key       string `json:"key"`
		Value     []byte `json:"value"`
	}{operation, string(key), value})
	if err != nil {
		return nil, &stateStoreError{operation, 0}
	}
	req, err := http.NewRequest(http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &stateStoreError{operation, 0}
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(req)
	if err != nil {
		return nil, &stateStoreError{operation, 0}
	}
	return response, nil
}

func (s *remoteStateStore) ReadState(key ipn.StateKey) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	response, err := s.request("read", key, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result struct {
		Value *[]byte `json:"value"`
		Code  string  `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, &stateStoreError{"read", response.StatusCode}
	}
	if response.StatusCode == http.StatusNotFound && result.Code == "STATE_NOT_FOUND" {
		return nil, ipn.ErrStateNotExist
	}
	if response.StatusCode != http.StatusOK || result.Value == nil {
		return nil, &stateStoreError{"read", response.StatusCode}
	}
	return *result.Value, nil
}

func (s *remoteStateStore) WriteState(key ipn.StateKey, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Preserve empty byte slices as values; tsnet's file store does not delete keys.
	if value == nil {
		value = []byte{}
	}
	response, err := s.request("write", key, value)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return &stateStoreError{"write", response.StatusCode}
	}
	return nil
}
