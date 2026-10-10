package otatrust

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func preparationArtifact(t *testing.T, name string, artifact releaseArtifact) releaseArtifact {
	t.Helper()
	archive, err := zip.OpenReader(name)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var inventory []byte
	for _, entry := range archive.File {
		if entry.Name == runtimeInventoryAsset {
			inventory, err = readAPKEntry(entry, 2*1024*1024)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if inventory == nil {
		t.Fatal("real runtime inventory missing")
	}
	artifact.Runtime.Inventory = bytesHash(inventory)
	artifact.Runtime.Libraries = map[string]string{}
	for _, line := range strings.Split(string(inventory), "\n")[1:] {
		fields := strings.Split(line, "\t")
		if len(fields) != 5 {
			continue
		}
		if fields[0] == "native" {
			artifact.Runtime.Libraries[fields[3]] = fields[2]
		}
		switch fields[4] {
		case "bundle/agent-bundle.js":
			artifact.Runtime.Agent = fields[2]
		case "bundle/gateway/local-agent-gateway.mjs":
			artifact.Runtime.Gateway = fields[2]
		case "bundle/gateway/task-runtime.mjs":
			artifact.Runtime.Policy = fields[2]
		}
	}
	file, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	artifact.Length, err = io.Copy(hash, file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	artifact.SHA256 = hex.EncodeToString(hash.Sum(nil))
	return artifact
}

// Explicit opt-in fixture export. APKs are real product release builds signed
// with a throwaway test key. The TUF root and policy here are controlled test
// authorities; nothing is published or included in a production APK.
func TestExportPreparationFixture(t *testing.T) {
	input, output, profilePath := os.Getenv("OTA_PREPARATION_APKS"), os.Getenv("OTA_PREPARATION_STATE"), os.Getenv("OTA_PREPARATION_PROFILE")
	if input == "" || output == "" || profilePath == "" {
		t.Skip("preparation fixture paths not supplied")
	}
	if _, err := os.Stat(filepath.Join(input, "INCOMPLETE")); !os.IsNotExist(err) {
		t.Fatal("incomplete fixture build")
	}
	var manifest struct {
		Distribution string `json:"distribution"`
		Signer       string `json:"signerSha256"`
		Artifacts    map[string]struct {
			File   string `json:"file"`
			Code   int64  `json:"versionCode"`
			Digest string `json:"sha256"`
			Length int64  `json:"length"`
		} `json:"artifacts"`
	}
	data, err := os.ReadFile(filepath.Join(input, "fixture-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if !validHex(manifest.Signer) || !contains([]string{"launcher", "standalone"}, manifest.Distribution) {
		t.Fatal("invalid fixture manifest")
	}
	var profile struct {
		SDK         int64  `json:"sdk"`
		Model       string `json:"model"`
		Fingerprint string `json:"buildFingerprint"`
		ABI         string `json:"abi"`
	}
	data, err = os.ReadFile(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &profile); err != nil {
		t.Fatal(err)
	}
	v := admissionVectors(t)[0]
	var d releaseDescriptor
	var device admissionDevice
	if err = json.Unmarshal(v.Release, &d); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(v.Device, &device); err != nil {
		t.Fatal(err)
	}
	d.Distribution = manifest.Distribution
	for _, item := range []struct {
		name     string
		artifact *releaseArtifact
	}{{"candidate", &d.Candidate}, {"recovery", &d.Recovery}} {
		row := manifest.Artifacts[item.name]
		if row.File != item.name+".apk" {
			t.Fatal("unexpected APK path")
		}
		*item.artifact = preparationArtifact(t, filepath.Join(input, row.File), *item.artifact)
		a := item.artifact
		if a.SHA256 != row.Digest || a.Length != row.Length {
			t.Fatal("APK changed after signing")
		}
		a.VersionCode = row.Code
		a.VersionName = "0.1." + strconv.FormatInt(row.Code, 10)
		a.Signer = manifest.Signer
		a.Android.SDK.Min = profile.SDK
		a.Android.SDK.Max = profile.SDK
		a.Android.Models = []string{profile.Model}
		a.Android.Fingerprints = []string{profile.Fingerprint}
		a.Android.ABIs = []string{profile.ABI}
		metadata, _ := json.Marshal(a)
		if err := VerifyRuntimeArtifact(filepath.Join(input, row.File), metadata, "github.com,updates.example.com", profile.ABI); err != nil {
			t.Fatal(err)
		}
	}
	baseline := manifest.Artifacts["baseline"]
	if baseline.Code != 1 || d.Candidate.VersionCode != 2 || d.Recovery.VersionCode != 3 || !validHex(baseline.Digest) {
		t.Fatal("unexpected fixture versions")
	}
	d.Candidate.Compatibility.Origins = []string{baseline.Digest}
	d.Recovery.Compatibility.Origins = []string{d.Candidate.SHA256}
	d.Safety.RecoveryFor = d.Candidate.SHA256
	d.Safety.FreeBytes = d.Candidate.Length + d.Recovery.Length + 4*1024*1024
	device.Distribution = manifest.Distribution
	device.Installed = baseline.Digest
	device.Version = baseline.Code
	device.Signer = manifest.Signer
	device.SDK = profile.SDK
	device.Model = profile.Model
	device.Fingerprint = profile.Fingerprint
	device.ABI = profile.ABI
	device.FreeBytes = 1 << 40
	r := fixture(t)
	rootHash := sha256.Sum256(r.root)
	config := enrollmentConfig{Schema: 1, Repository: d.Source.Repository, Distribution: d.Distribution, Signer: manifest.Signer, RootHash: hex.EncodeToString(rootHash[:]), MetadataBase: baseURL, Hosts: []string{"updates.example.com", "github.com"}}
	configJSON, _ := json.Marshal(config)
	enrollmentDir := privateDir(t)
	if err = InitializeEnrollment(enrollmentDir, configJSON, r.root); err != nil {
		t.Fatal(err)
	}
	enrollment, err := ReadEnrollment(enrollmentDir)
	if err != nil {
		t.Fatal(err)
	}
	device.CohortID = enrollment.CohortID
	deviceJSON, _ := json.Marshal(device)
	admissionDir, preparedDir, scheduleDir, cacheDir := privateDir(t), privateDir(t), privateDir(t), privateDir(t)
	if err = InitializeAdmissionState(admissionDir, config.Repository, d.Distribution); err != nil {
		t.Fatal(err)
	}
	r.body, _ = json.Marshal(d)
	r.publishDistribution(t, 1, manifest.Distribution)
	discovery, err := newEnrolledDiscovery(enrollmentDir, func(string) (discoveryTransport, error) { return &discoveryFixture{repository: r}, nil })
	if err != nil {
		t.Fatal(err)
	}
	clock := &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli() + 1000}}
	discovery.session.source = clock
	result, err := discovery.RunWithTimeSource(scheduleDir, cacheDir, admissionDir, preparedDir, deviceJSON, 1, 0)
	if err != nil || result.Status != "admitted" {
		t.Fatalf("signed fixture admission failed: %+v %v", result, err)
	}
	if err = os.Mkdir(output, 0700); err != nil {
		t.Fatal(err)
	}
	for name, source := range map[string]string{"ota-enrollment": enrollmentDir, "ota-admission": admissionDir, "ota-prepared": preparedDir, "ota-schedule": scheduleDir} {
		destination := filepath.Join(output, name)
		if err = os.Mkdir(destination, 0700); err != nil {
			t.Fatal(err)
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(source, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(destination, entry.Name()), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	write := func(name string, value any) {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(output, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("device.json", device)
	write("descriptor.json", d)
	write("resume.json", map[string]any{"id": result.AuthorizationID, "trustedLowerMs": clock.bounds.LowerMillis, "trustedUpperMs": clock.bounds.UpperMillis, "baselineSha256": baseline.Digest, "baselineVersionCode": baseline.Code, "distribution": manifest.Distribution})
	t.Log("Authenticated fixture exported; capability/health observations are controlled test values, not device qualification.")
}
