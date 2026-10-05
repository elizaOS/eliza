package otatrust

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const safeInteger int64 = 9007199254740991

type releaseRange struct {
	Min int64 `json:"min"`
	Max int64 `json:"max"`
}
type releaseAndroid struct {
	SDK          releaseRange `json:"sdk"`
	TargetSDK    int64        `json:"targetSdk"`
	ABIs         []string     `json:"abis"`
	Models       []string     `json:"models"`
	Fingerprints []string     `json:"buildFingerprints"`
	Capabilities []string     `json:"installerCapabilities"`
}
type releaseDatabase struct {
	Read  releaseRange `json:"read"`
	Write releaseRange `json:"write"`
}
type releaseCompatibility struct {
	Agent      releaseRange    `json:"agentProtocol"`
	Database   releaseDatabase `json:"database"`
	Supervisor int64           `json:"minimumSupervisor"`
	Browser    releaseRange    `json:"browserProtocol"`
	Origins    []string        `json:"upgradeOrigins"`
}
type releaseRuntime struct {
	Inventory string            `json:"inventorySha256"`
	Agent     string            `json:"agentSha256"`
	Gateway   string            `json:"gatewaySha256"`
	Policy    string            `json:"policySha256"`
	Libraries map[string]string `json:"nativeLibraries"`
}
type releaseArtifact struct {
	SHA256        string               `json:"sha256"`
	Length        int64                `json:"length"`
	URL           string               `json:"url"`
	Mirrors       []string             `json:"mirrors"`
	VersionCode   int64                `json:"versionCode"`
	VersionName   string               `json:"versionName"`
	Signer        string               `json:"signerSha256"`
	SecurityEpoch int64                `json:"securityEpoch"`
	Android       releaseAndroid       `json:"android"`
	Compatibility releaseCompatibility `json:"compatibility"`
	Runtime       releaseRuntime       `json:"runtime"`
}
type releaseSource struct {
	Repository string   `json:"repository"`
	Tag        string   `json:"tag"`
	Commit     string   `json:"commit"`
	Upstream   string   `json:"upstreamCommit"`
	Patches    []string `json:"patchSha256"`
}
type releaseSafety struct {
	RecoveryFor string `json:"recoveryForSha256"`
	FreeBytes   int64  `json:"minimumFreeBytes"`
	Health      string `json:"healthProfile"`
	Activation  string `json:"activationProfile"`
}
type releaseRollout struct {
	Seed      string   `json:"seed"`
	Threshold int64    `json:"threshold"`
	Starts    string   `json:"starts"`
	Expires   string   `json:"expires"`
	Revision  int64    `json:"revision"`
	Paused    bool     `json:"paused"`
	Revoked   []string `json:"revokedSha256"`
}
type releaseDescriptor struct {
	Schema        int64           `json:"schemaVersion"`
	Product       string          `json:"product"`
	Package       string          `json:"packageId"`
	Distribution  string          `json:"distribution"`
	Channel       string          `json:"channel"`
	ID            string          `json:"releaseId"`
	Sequence      int64           `json:"sequence"`
	SecurityFloor int64           `json:"securityFloor"`
	Source        releaseSource   `json:"source"`
	Candidate     releaseArtifact `json:"candidate"`
	Recovery      releaseArtifact `json:"recovery"`
	Safety        releaseSafety   `json:"safety"`
	Rollout       releaseRollout  `json:"rollout"`
}
type admissionDevice struct {
	Channel      string   `json:"requestedChannel"`
	Distribution string   `json:"distribution"`
	Quarantine   []string `json:"quarantine"`
	Installed    string   `json:"installedSha256"`
	Version      int64    `json:"installedVersionCode"`
	Signer       string   `json:"signerSha256"`
	SDK          int64    `json:"sdk"`
	ABI          string   `json:"abi"`
	Model        string   `json:"model"`
	Fingerprint  string   `json:"buildFingerprint"`
	Capabilities []string `json:"installerCapabilities"`
	Supervisor   int64    `json:"supervisorVersion"`
	Agent        int64    `json:"agentProtocol"`
	Browser      int64    `json:"browserProtocol"`
	Database     int64    `json:"databaseSchema"`
	FreeBytes    int64    `json:"freeBytes"`
	Health       []string `json:"healthProfiles"`
	Activation   []string `json:"activationProfiles"`
	CohortID     string   `json:"opaqueCohortId"`
}
type admissionPolicy struct {
	Repository    string   `json:"repository"`
	Hosts         []string `json:"artifactHosts"`
	Lower         int64    `json:"trustedLowerMs"`
	Upper         int64    `json:"trustedUpperMs"`
	Sequence      int64    `json:"minimumSequence"`
	Revision      int64    `json:"minimumRolloutRevision"`
	SecurityFloor int64    `json:"securityFloor"`
}

type AdmissionResult struct {
	Decision         string
	Reason           string
	EffectiveChannel string
	ReleaseID        string
	Sequence         int64
	CandidateSHA256  string
	RecoverySHA256   string
}

// EvaluateReleaseInterval applies policy after descriptor authentication. The
// entire trusted interval must fit the rollout window. Device observations and
// bounds must come from the supervisor; this does not authorize installation.
func EvaluateReleaseInterval(descriptor, deviceJSON, policyJSON []byte) (*AdmissionResult, error) {
	var d releaseDescriptor
	var device admissionDevice
	var policy admissionPolicy
	for _, input := range []struct {
		data  []byte
		value any
	}{{descriptor, &d}, {deviceJSON, &device}, {policyJSON, &policy}} {
		if err := decodeAdmission(input.data, input.value); err != nil {
			return nil, err
		}
	}
	return evaluateRelease(d, device, policy)
}

func evaluateRelease(d releaseDescriptor, device admissionDevice, policy admissionPolicy) (*AdmissionResult, error) {
	host, hostErr := requiredHostPolicy()
	if hostErr != nil {
		return nil, hostErr
	}
	if err := validateNativeRelease(d, policy.Hosts); err != nil {
		return nil, err
	}
	if err := validateAdmissionPolicy(policy); err != nil {
		return nil, err
	}
	if err := validateAdmissionDevice(device); err != nil {
		return nil, err
	}
	deferFor := func(reason string) (*AdmissionResult, error) {
		return &AdmissionResult{Decision: "defer", Reason: reason}, nil
	}
	if d.Source.Repository != policy.Repository {
		return deferFor("repository-mismatch")
	}
	if device.Channel != d.Channel {
		return deferFor("channel-mismatch")
	}
	if device.Distribution != d.Distribution {
		return deferFor("distribution-mismatch")
	}
	if d.Sequence < policy.Sequence || d.Rollout.Revision < policy.Revision {
		return deferFor("metadata-rollback")
	}
	if d.Rollout.Paused {
		return deferFor("rollout-paused")
	}
	starts, _ := releaseTime(d.Rollout.Starts)
	expires, _ := releaseTime(d.Rollout.Expires)
	if policy.Lower < starts || policy.Upper >= expires {
		return deferFor("rollout-time")
	}
	if contains(d.Rollout.Revoked, d.Candidate.SHA256) || contains(d.Rollout.Revoked, d.Recovery.SHA256) {
		return deferFor("revoked-artifact")
	}
	if d.SecurityFloor < policy.SecurityFloor || d.Candidate.SecurityEpoch < policy.SecurityFloor || d.Recovery.SecurityEpoch < policy.SecurityFloor {
		return deferFor("security-floor")
	}
	if contains(device.Quarantine, d.Candidate.SHA256) || contains(device.Quarantine, d.Recovery.SHA256) {
		return deferFor("quarantined")
	}
	if d.Candidate.Signer != device.Signer {
		return deferFor("signer-mismatch")
	}
	if d.Candidate.SHA256 == device.Installed && d.Candidate.VersionCode == device.Version {
		return &AdmissionResult{Decision: "already-installed", EffectiveChannel: d.Channel}, nil
	}
	if d.Candidate.VersionCode <= device.Version {
		return deferFor("await-forward-version")
	}
	if !contains(d.Candidate.Compatibility.Origins, device.Installed) {
		return deferFor("bridge-release-required")
	}
	for _, a := range []releaseArtifact{d.Candidate, d.Recovery} {
		if a.Signer != device.Signer {
			return deferFor("signer-mismatch")
		}
		if !inRange(a.Android.SDK, device.SDK) || !contains(a.Android.ABIs, device.ABI) || !contains(a.Android.Models, device.Model) || !contains(a.Android.Fingerprints, device.Fingerprint) {
			return deferFor("unqualified-device")
		}
		for _, cap := range a.Android.Capabilities {
			if !contains(device.Capabilities, cap) {
				return deferFor("installer-authority")
			}
		}
		if device.Supervisor < a.Compatibility.Supervisor || !inRange(a.Compatibility.Agent, device.Agent) || !inRange(a.Compatibility.Browser, device.Browser) {
			return deferFor("protocol-incompatible")
		}
		if !inRange(a.Compatibility.Database.Read, device.Database) {
			return deferFor("data-incompatible")
		}
	}
	if device.FreeBytes < d.Safety.FreeBytes {
		return deferFor("disk-reserve")
	}
	if !contains(device.Health, d.Safety.Health) || !contains(device.Activation, d.Safety.Activation) {
		return deferFor("unsupported-safety-profile")
	}
	sum := sha256.Sum256([]byte(host.CohortDomain + "\x00" + d.Rollout.Seed + "\x00" + device.CohortID))
	bucket := int64(binary.BigEndian.Uint32(sum[:4]) % 10000)
	if bucket >= d.Rollout.Threshold {
		return deferFor("outside-cohort")
	}
	return &AdmissionResult{Decision: "eligible", ReleaseID: d.ID, Sequence: d.Sequence, CandidateSHA256: d.Candidate.SHA256, RecoverySHA256: d.Recovery.SHA256}, nil
}

const idPattern = `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$`
const repositoryPattern = `^[a-zA-Z0-9_-]+/[a-zA-Z0-9._-]+$`

func matches(s, pattern string) bool { return regexp.MustCompile(pattern).MatchString(s) }
func bounded(n, min, max int64) bool { return n >= min && n <= max }
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func inRange(r releaseRange, n int64) bool { return bounded(n, r.Min, r.Max) }
func validRange(r releaseRange) bool {
	return bounded(r.Min, 1, 2147483647) && bounded(r.Max, r.Min, 2147483647)
}
func stringList(values []string, min, max int, valid func(string) bool) bool {
	if len(values) < min || len(values) > max {
		return false
	}
	seen := map[string]bool{}
	for _, s := range values {
		if seen[s] || !valid(s) {
			return false
		}
		seen[s] = true
	}
	return true
}
func identifier(s string) bool { return matches(s, idPattern) }
func releaseTime(s string) (int64, bool) {
	const layout = "2006-01-02T15:04:05.000Z"
	if !matches(s, `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$`) {
		return 0, false
	}
	value, err := time.Parse(layout, s)
	return value.UnixMilli(), err == nil && value.Format(layout) == s
}
func artifactURL(address string, hosts []string) bool {
	if len(address) > 2048 {
		return false
	}
	u, err := url.Parse(address)
	return err == nil && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(address, "#") && contains(hosts, u.Hostname()) && u.Host == u.Hostname() && u.String() == address && u.Path != "" && !strings.ContainsAny(u.Path, "%\\") && u.RawPath == "" && !matches(u.Path, `(^|/)\.\.?(/|$)`)
}
func validateNativeRelease(d releaseDescriptor, hosts []string) error {
	host, hostErr := requiredHostPolicy()
	if hostErr != nil {
		return hostErr
	}
	bad := func() error { return errors.New("invalid native release contract") }
	if !stringList(hosts, 1, 16, func(s string) bool {
		return hostnamePattern.MatchString(s) && !strings.HasSuffix(s, ".local") && !strings.HasSuffix(s, ".localhost") && !strings.HasSuffix(s, ".internal")
	}) || !contains(hosts, "github.com") {
		return bad()
	}
	if d.Schema != 1 || d.Product != host.Product || d.Package != host.Package || !contains([]string{"launcher", "standalone"}, d.Distribution) || !contains([]string{"stable", "beta"}, d.Channel) || !identifier(d.ID) || !bounded(d.Sequence, 1, safeInteger) || !bounded(d.SecurityFloor, 1, 2147483647) {
		return bad()
	}
	if !matches(d.Source.Repository, repositoryPattern) || !identifier(d.Source.Tag) || !matches(d.Source.Commit, `^[a-f0-9]{40}$`) || !matches(d.Source.Upstream, `^[a-f0-9]{40}$`) || !stringList(d.Source.Patches, 0, 128, validHex) {
		return bad()
	}
	for _, a := range []releaseArtifact{d.Candidate, d.Recovery} {
		if err := validateNativeArtifact(a, hosts); err != nil {
			return err
		}
		prefix := "https://github.com/" + d.Source.Repository + "/releases/download/" + d.Source.Tag + "/"
		if !strings.HasPrefix(a.URL, prefix) || !matches(strings.TrimPrefix(a.URL, prefix), `^[-a-zA-Z0-9_.]+\.apk$`) || a.SecurityEpoch < d.SecurityFloor {
			return bad()
		}
	}
	candidate, recovery := d.Candidate, d.Recovery
	if candidate.SHA256 == recovery.SHA256 || recovery.VersionCode <= candidate.VersionCode || candidate.Signer != recovery.Signer || !contains(recovery.Compatibility.Origins, candidate.SHA256) {
		return bad()
	}
	writes, reads := candidate.Compatibility.Database.Write, recovery.Compatibility.Database.Read
	if reads.Min > writes.Min || reads.Max < writes.Max || d.Safety.RecoveryFor != candidate.SHA256 || !bounded(d.Safety.FreeBytes, candidate.Length+recovery.Length, safeInteger) || !identifier(d.Safety.Health) || !identifier(d.Safety.Activation) {
		return bad()
	}
	starts, ok1 := releaseTime(d.Rollout.Starts)
	expires, ok2 := releaseTime(d.Rollout.Expires)
	if !validHex(d.Rollout.Seed) || !bounded(d.Rollout.Threshold, 0, 10000) || !bounded(d.Rollout.Revision, 1, safeInteger) || !ok1 || !ok2 || starts >= expires || !stringList(d.Rollout.Revoked, 0, 4096, validHex) {
		return bad()
	}
	return nil
}
func validateNativeArtifact(a releaseArtifact, hosts []string) error {
	bad := func() error { return errors.New("invalid native artifact contract") }
	if !validHex(a.SHA256) || !validHex(a.Signer) || !bounded(a.Length, 1, maxArtifactBytes) || !bounded(a.VersionCode, 1, 2100000000) || !matches(a.VersionName, `^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$`) || !bounded(a.SecurityEpoch, 1, 2147483647) || !artifactURL(a.URL, hosts) || !stringList(a.Mirrors, 0, 8, func(s string) bool { return artifactURL(s, hosts) }) || contains(a.Mirrors, a.URL) {
		return bad()
	}
	platform := a.Android
	if !validRange(platform.SDK) || !bounded(platform.TargetSDK, platform.SDK.Min, 2147483647) || !stringList(platform.ABIs, 1, 4, func(s string) bool { return contains([]string{"arm64-v8a", "armeabi-v7a", "x86_64", "x86"}, s) }) || !stringList(platform.Models, 1, 128, func(s string) bool { return matches(s, `^[a-zA-Z0-9][a-zA-Z0-9 ._()-]{0,127}$`) }) || !stringList(platform.Fingerprints, 1, 256, func(s string) bool { return matches(s, `^[a-zA-Z0-9][a-zA-Z0-9:/. _+-]{0,511}$`) }) || !stringList(platform.Capabilities, 1, 8, func(s string) bool {
		return contains([]string{"device-owner", "privileged-installer", "silent-install", "forward-recovery"}, s)
	}) {
		return bad()
	}
	c := a.Compatibility
	if !validRange(c.Agent) || !validRange(c.Browser) || !bounded(c.Supervisor, 1, 2100000000) || !validRange(c.Database.Read) || !validRange(c.Database.Write) || c.Database.Read.Min > c.Database.Write.Min || c.Database.Read.Max < c.Database.Write.Max || !stringList(c.Origins, 1, 128, validHex) {
		return bad()
	}
	r := a.Runtime
	if !validHex(r.Inventory) || !validHex(r.Agent) || !validHex(r.Gateway) || !validHex(r.Policy) || len(r.Libraries) < 1 || len(r.Libraries) > 128 || r.Libraries["libeliza_bun.so"] == "" {
		return bad()
	}
	for name, hash := range r.Libraries {
		if !matches(name, `^lib[a-zA-Z0-9_-]+\.so$`) || !validHex(hash) {
			return bad()
		}
	}
	return nil
}
func validateAdmissionDevice(d admissionDevice) error {
	bad := func() error { return errors.New("invalid native device observations") }
	if !contains([]string{"stable", "beta"}, d.Channel) || !contains([]string{"launcher", "standalone"}, d.Distribution) || !validHex(d.Installed) || !validHex(d.Signer) || !validHex(d.CohortID) || !bounded(d.FreeBytes, 0, safeInteger) || !stringList(d.Quarantine, 0, 4096, validHex) {
		return bad()
	}
	for _, n := range []int64{d.Version, d.SDK, d.Supervisor, d.Agent, d.Browser, d.Database} {
		if !bounded(n, 1, 2100000000) {
			return bad()
		}
	}
	for _, s := range []string{d.ABI, d.Model, d.Fingerprint} {
		if len(s) == 0 || len(s) > 512 {
			return bad()
		}
	}
	for _, list := range [][]string{d.Capabilities, d.Health, d.Activation} {
		if !stringList(list, 0, 128, identifier) {
			return bad()
		}
	}
	return nil
}

// Exact shape checking avoids encoding/json's case-insensitive field aliases,
// omitted required fields and null-to-zero conversions. Numbers are canonical
// decimal integers; input is bounded before parsing and duplicate keys rejected.
func decodeAdmission(data []byte, destination any) error {
	if len(data) == 0 || int64(len(data)) > maxBytes || !utf8.Valid(data) {
		return errors.New("invalid admission JSON size/encoding")
	}
	if err := checkJSON(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if !admissionShape(value, reflect.TypeOf(destination).Elem()) {
		return errors.New("invalid admission JSON shape")
	}
	return json.Unmarshal(data, destination)
}
func admissionShape(value any, typ reflect.Type) bool {
	switch typ.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok || len(object) != typ.NumField() {
			return false
		}
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			v, present := object[field.Tag.Get("json")]
			if !present || !admissionShape(v, field.Type) {
				return false
			}
		}
		return true
	case reflect.Slice:
		array, ok := value.([]any)
		if !ok || len(array) > 4096 {
			return false
		}
		for _, item := range array {
			if !admissionShape(item, typ.Elem()) {
				return false
			}
		}
		return true
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok || len(object) > 4096 {
			return false
		}
		for key, item := range object {
			if !admissionShape(key, typ.Key()) || !admissionShape(item, typ.Elem()) {
				return false
			}
		}
		return true
	case reflect.String:
		s, ok := value.(string)
		return ok && len(s) <= 4096 && !strings.ContainsRune(s, utf8.RuneError)
	case reflect.Int64:
		n, ok := value.(json.Number)
		if !ok || !matches(string(n), `^(0|[1-9][0-9]*)$`) {
			return false
		}
		integer, err := n.Int64()
		return err == nil && integer <= safeInteger
	case reflect.Bool:
		_, ok := value.(bool)
		return ok
	}
	return false
}

func validateAdmissionPolicy(policy admissionPolicy) error {
	if !matches(policy.Repository, repositoryPattern) || !bounded(policy.Lower, 1, safeInteger) || !bounded(policy.Upper, policy.Lower, safeInteger) || !bounded(policy.Sequence, 1, safeInteger) || !bounded(policy.Revision, 1, safeInteger) || !bounded(policy.SecurityFloor, 1, safeInteger) {
		return errors.New("invalid native trust observations")
	}
	return nil
}
