package otatrust

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// Historical downstream vectors qualify compatibility only. No production
// package default exists: host policy must be embedded by the signed build.
func TestMain(m *testing.M) {
	if compiledHostPolicyBase64 == "" {
		compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString([]byte(`{"schema":2,"product":"senior-care","package":"ai.elizaresearch.seniorcare","cohortDomain":"senior-care-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1","runtimeExcludedAgentDirectories":["models"]}`))
	}
	os.Exit(m.Run())
}
func TestHostPolicyFailsClosed(t *testing.T) {
	saved := compiledHostPolicyBase64
	defer func() { compiledHostPolicyBase64 = saved }()
	v := admissionVectors(t)[0]
	for _, value := range []string{"", "invalid", base64.RawURLEncoding.EncodeToString([]byte(`{"schema":1}`)),
		// Schema 1 lacked runtime exclusions and must be migrated explicitly.
		base64.RawURLEncoding.EncodeToString([]byte(`{"schema":1,"product":"senior-care","package":"ai.elizaresearch.seniorcare","cohortDomain":"senior-care-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"schema":2,"product":"senior-care","package":"ai.elizaresearch.seniorcare","cohortDomain":"senior-care-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1","runtimeExcludedAgentDirectories":["../models"]}`))} {
		compiledHostPolicyBase64 = value
		if _, err := EvaluateReleaseInterval(v.Release, v.Device, v.Policy); err == nil {
			t.Fatal("unconfigured host admitted release")
		}
		if err := VerifyRuntimeArtifact("unused", nil, "github.com", "arm64-v8a"); err == nil {
			t.Fatal("unconfigured host accepted artifact")
		}
	}
}
func TestIndependentHostCannotAdmitLegacyProduct(t *testing.T) {
	saved := compiledHostPolicyBase64
	defer func() { compiledHostPolicyBase64 = saved }()
	policy, err := requiredHostPolicy()
	if err != nil {
		t.Fatal(err)
	}
	policy.Product = "independent-host"
	policy.Package = "org.example.independent"
	policy.CohortDomain = "independent-ota-v1"
	policy.RuntimeInventoryHeader = "independent-runtime-v1"
	data, _ := json.Marshal(policy)
	compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString(data)
	v := admissionVectors(t)[0]
	if _, err := EvaluateReleaseInterval(v.Release, v.Device, v.Policy); err == nil {
		t.Fatal("another product admitted")
	}
	release := bytes.ReplaceAll(v.Release, []byte(`"senior-care"`), []byte(`"independent-host"`))
	release = bytes.ReplaceAll(release, []byte(`"ai.elizaresearch.seniorcare"`), []byte(`"org.example.independent"`))
	result, err := EvaluateReleaseInterval(release, v.Device, v.Policy)
	if err != nil || result.Decision != "eligible" {
		t.Fatalf("independent policy rejected: %+v %v", result, err)
	}
}
