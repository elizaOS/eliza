package otatrust

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// The vectors name this test default; admissionVectors rebinds them to any
// other compiled host. No production package default exists: host policy must
// be embedded by the signed build.
func TestMain(m *testing.M) {
	if compiledHostPolicyBase64 == "" {
		compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString([]byte(`{"schema":2,"product":"example-app","package":"com.example.app","cohortDomain":"example-app-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1","runtimeExcludedAgentDirectories":["models"]}`))
	}
	os.Exit(m.Run())
}
func TestHostPolicyFailsClosed(t *testing.T) {
	saved := compiledHostPolicyBase64
	defer func() { compiledHostPolicyBase64 = saved }()
	v := admissionVectors(t)[0]
	for _, value := range []string{"", "invalid", base64.RawURLEncoding.EncodeToString([]byte(`{"schema":1}`)),
		// Schema 1 lacked runtime exclusions and must be migrated explicitly.
		base64.RawURLEncoding.EncodeToString([]byte(`{"schema":1,"product":"example-app","package":"com.example.app","cohortDomain":"example-app-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"schema":2,"product":"example-app","package":"com.example.app","cohortDomain":"example-app-ota-v1","runtimeInventoryHeader":"eliza-runtime-v1","runtimeExcludedAgentDirectories":["../models"]}`))} {
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
	legacy := admissionVectors(t)[0]
	product, _ := json.Marshal(policy.Product)
	pkg, _ := json.Marshal(policy.Package)
	policy.Product = "independent-host"
	policy.Package = "org.example.independent"
	policy.CohortDomain = "independent-ota-v1"
	policy.RuntimeInventoryHeader = "independent-runtime-v1"
	data, _ := json.Marshal(policy)
	compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString(data)
	if _, err := EvaluateReleaseInterval(legacy.Release, legacy.Device, legacy.Policy); err == nil {
		t.Fatal("another product admitted")
	}
	release := bytes.ReplaceAll(legacy.Release, product, []byte(`"independent-host"`))
	release = bytes.ReplaceAll(release, pkg, []byte(`"org.example.independent"`))
	result, err := EvaluateReleaseInterval(release, legacy.Device, legacy.Policy)
	if err != nil || result.Decision != "eligible" {
		t.Fatalf("independent policy rejected: %+v %v", result, err)
	}
}

// The vectors a host build runs and exports (TestExportAndroidFixture) are
// bound to its compiled policy and keep every reference result.
func TestVectorsBindToCompiledHost(t *testing.T) {
	saved := compiledHostPolicyBase64
	defer func() { compiledHostPolicyBase64 = saved }()
	compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString([]byte(`{"schema":2,"product":"independent-host","package":"org.example.independent","cohortDomain":"independent-ota-v1","runtimeInventoryHeader":"independent-runtime-v1","runtimeExcludedAgentDirectories":[]}`))
	vectors := admissionVectors(t)
	if !bytes.Contains(vectors[0].Release, []byte(`"independent-host"`)) || bytes.Contains(vectors[0].Release, []byte(`"`+vectorProduct+`"`)) {
		t.Fatal("vectors not bound to the compiled host")
	}
	TestNativeAdmissionReferenceParity(t)
}
