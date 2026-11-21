package otatrust

import (
	"encoding/base64"
	"encoding/json"
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

type nodeHostPolicy struct {
	Schema       int64  `json:"schema"`
	Product      string `json:"product"`
	Package      string `json:"package"`
	CohortDomain string `json:"cohortDomain"`
}

func requiredHostPolicy() (hostPolicy, error) {
	var policy hostPolicy
	data, err := base64.RawURLEncoding.DecodeString(compiledHostPolicyBase64)
	if err != nil || len(data) == 0 || len(data) > 4096 {
		return policy, errors.New("native host policy is not configured")
	}
	var version struct {
		Schema int64 `json:"schema"`
	}
	invalid := errors.New("invalid native host policy")
	if json.Unmarshal(data, &version) != nil {
		return policy, invalid
	}
	switch version.Schema {
	case 2:
		if decodeAdmission(data, &policy) != nil ||
			!stringList(policy.RuntimeExcludedAgentDirectories, 0, 64, runtimePath) ||
			!matches(policy.RuntimeInventoryHeader, `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) {
			return policy, invalid
		}
	case 3:
		var node nodeHostPolicy
		if decodeAdmission(data, &node) != nil {
			return policy, invalid
		}
		policy = hostPolicy{Schema: node.Schema, Product: node.Product, Package: node.Package, CohortDomain: node.CohortDomain}
	default:
		return policy, invalid
	}
	if !matches(policy.Product, `^[a-z][a-z0-9-]{0,63}$`) || !matches(policy.Package, `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`) || len(policy.Package) > 255 || !matches(policy.CohortDomain, `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) || strings.ContainsRune(policy.CohortDomain, 0) {
		return policy, invalid
	}
	return policy, nil
}
