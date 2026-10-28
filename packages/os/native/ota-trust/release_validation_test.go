package otatrust

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestReleaseValidationUsesNativeContractWithoutDeviceState(t *testing.T) {
	vector := admissionVectors(t)[0]
	var release releaseDescriptor
	if err := json.Unmarshal(vector.Release, &release); err != nil {
		t.Fatal(err)
	}
	hosts := []string{"github.com"}
	if err := ValidateReleaseDescriptor(vector.Release, release.Source.Repository, hosts); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*releaseDescriptor){
		"wrong product": func(d *releaseDescriptor) { d.Product = "another-product" },
		"wrong package": func(d *releaseDescriptor) { d.Package = "org.example.other" },
		"recovery code": func(d *releaseDescriptor) { d.Recovery.VersionCode = d.Candidate.VersionCode },
		"recovery signer": func(d *releaseDescriptor) {
			d.Recovery.Signer = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
		},
		"recovery reader":   func(d *releaseDescriptor) { d.Recovery.Compatibility.Database.Read.Max = 0 },
		"recovery origin":   func(d *releaseDescriptor) { d.Recovery.Compatibility.Origins = nil },
		"unapproved mirror": func(d *releaseDescriptor) { d.Candidate.Mirrors = []string{"https://unapproved.example/app.apk"} },
	} {
		t.Run(name, func(t *testing.T) {
			var changed releaseDescriptor
			if err := json.Unmarshal(vector.Release, &changed); err != nil {
				t.Fatal(err)
			}
			mutate(&changed)
			data, err := json.Marshal(changed)
			if err != nil {
				t.Fatal(err)
			}
			if ValidateReleaseDescriptor(data, release.Source.Repository, hosts) == nil {
				t.Fatal("invalid release accepted")
			}
		})
	}
	if ValidateReleaseDescriptor(vector.Release, "another/repository", hosts) == nil {
		t.Fatal("repository policy ignored")
	}
	if ValidateReleaseDescriptor(vector.Release, release.Source.Repository, nil) == nil {
		t.Fatal("missing host policy accepted")
	}
	duplicate := bytes.Replace(vector.Release, []byte(`"schemaVersion": 1`), []byte(`"schemaVersion": 1, "schemaVersion": 1`), 1)
	if bytes.Equal(duplicate, vector.Release) {
		t.Fatal("duplicate-key mutation missed")
	}
	if ValidateReleaseDescriptor(duplicate, release.Source.Repository, hosts) == nil {
		t.Fatal("ambiguous descriptor accepted")
	}
}

func TestReleaseValidationCommandBindsStdinBytes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	executable := filepath.Join(t.TempDir(), "verify-release")
	linker := "-X=github.com/elizaOS/eliza/packages/os/native/ota-trust.compiledHostPolicyBase64=" + compiledHostPolicyBase64
	build := exec.CommandContext(ctx, "go", "build", "-ldflags="+linker, "-o", executable, "./cmd/verify-release")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", output, err)
	}
	vector := admissionVectors(t)[0]
	var descriptor releaseDescriptor
	if err := json.Unmarshal(vector.Release, &descriptor); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, executable, "-repository", descriptor.Source.Repository, "-hosts", "github.com")
	command.Stdin = bytes.NewReader(vector.Release)
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Verified      bool   `json:"releaseContractVerified"`
		SHA256        string `json:"descriptorSha256"`
		Authenticated bool   `json:"authenticated"`
	}
	if err = json.Unmarshal(output, &report); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(vector.Release)
	if !report.Verified || report.SHA256 != hex.EncodeToString(digest[:]) || report.Authenticated {
		t.Fatalf("invalid evidence: %s", output)
	}
	for name, input := range map[string][]byte{"empty": nil, "oversized": bytes.Repeat([]byte(" "), 1024*1024+1), "malformed": []byte(`{"schemaVersion":1,"schemaVersion":1}`)} {
		t.Run(name, func(t *testing.T) {
			command := exec.CommandContext(ctx, executable, "-repository", descriptor.Source.Repository, "-hosts", "github.com")
			command.Stdin = bytes.NewReader(input)
			if output, err := command.Output(); err == nil || len(output) != 0 {
				t.Fatalf("invalid input produced evidence: %s %v", output, err)
			}
		})
	}
}
