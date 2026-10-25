package otatrust

import (
	"encoding/base64"
	"errors"
	"strings"
)

// Set only by the reviewed host build using -ldflags -X. There is deliberately
// no runtime setter: metadata, remote callers and renderers cannot select it.
// An unconfigured build rejects product admission and runtime artifact checks.
var compiledHostPolicyBase64 string

type hostPolicy struct {
	Schema                 int64  `json:"schema"`
	Product                string `json:"product"`
	Package                string `json:"package"`
	CohortDomain           string `json:"cohortDomain"`
	RuntimeInventoryHeader string `json:"runtimeInventoryHeader"`
	// Agent asset directories the host excludes from the runtime inventory
	// (stageAndroidRuntimeInventory excludedAgentDirectories) and reads directly
	// from APK assets. They are covered only by the whole-APK digest.
	RuntimeExcludedAgentDirectories []string `json:"runtimeExcludedAgentDirectories"`
}

func requiredHostPolicy() (hostPolicy, error) {
	var policy hostPolicy
	data, err := base64.RawURLEncoding.DecodeString(compiledHostPolicyBase64)
	if err != nil || len(data) == 0 || len(data) > 4096 {
		return policy, errors.New("native host policy is not configured")
	}
	if err = decodeAdmission(data, &policy); err != nil {
		return policy, errors.New("invalid native host policy")
	}
	if policy.Schema != 2 || !stringList(policy.RuntimeExcludedAgentDirectories, 0, 64, runtimePath) || !matches(policy.Product, `^[a-z][a-z0-9-]{0,63}$`) || !matches(policy.Package, `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`) || len(policy.Package) > 255 || !matches(policy.CohortDomain, `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) || !matches(policy.RuntimeInventoryHeader, `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) || strings.ContainsRune(policy.CohortDomain, 0) {
		return policy, errors.New("invalid native host policy")
	}
	return policy, nil
}
