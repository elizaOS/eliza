package otatrust

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func enrollmentFixture(t *testing.T) ([]byte, []byte) {
	t.Helper()
	r := fixture(t)
	sum := sha256.Sum256(r.root)
	c := enrollmentConfig{Schema: 1, Repository: "eliza-research/senior-care", Distribution: "launcher", Signer: string(bytes.Repeat([]byte("a"), 64)), RootHash: hex.EncodeToString(sum[:]), MetadataBase: baseURL, Hosts: []string{"updates.example.com", "github.com", "release-assets.githubusercontent.com"}}
	data, e := json.Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	return data, r.root
}
func TestEnrollmentPersistsAndNeverResets(t *testing.T) {
	c, r := enrollmentFixture(t)
	dir := enrollmentDirectory(t)
	if _, e := ReadEnrollment(dir); e == nil {
		t.Fatal("missing state accepted")
	}
	if e := InitializeEnrollment(dir, c, r); e != nil {
		t.Fatal(e)
	}
	a, e := ReadEnrollment(dir)
	if e != nil {
		t.Fatal(e)
	}
	b, e := ReadEnrollment(dir)
	if e != nil {
		t.Fatal(e)
	}
	if a.CohortID != b.CohortID || !bytes.Equal(a.Root, r) || !bytes.Equal(a.Config, c) {
		t.Fatal("enrollment changed")
	}
	if e = InitializeEnrollment(dir, c, r); e == nil {
		t.Fatal("reenrolled")
	}
	if e = os.Remove(filepath.Join(dir, "enrollment.json")); e != nil {
		t.Fatal(e)
	}
	if _, e = ReadEnrollment(dir); e == nil {
		t.Fatal("lost state accepted")
	}
	if e = InitializeEnrollment(dir, c, r); e == nil {
		t.Fatal("lost enrollment reset")
	}
	other := enrollmentDirectory(t)
	if e = InitializeEnrollment(other, c, r); e != nil {
		t.Fatal(e)
	}
	d, e := ReadEnrollment(other)
	if e != nil || a.CohortID == d.CohortID {
		t.Fatal("cohort was not device-specific", e)
	}
}
func TestEnrollmentRejectsInvalidProvisioning(t *testing.T) {
	c, r := enrollmentFixture(t)
	for _, mutate := range []func(*enrollmentConfig){
		func(c *enrollmentConfig) { c.Schema = 2 }, func(c *enrollmentConfig) { c.Repository = "../other" }, func(c *enrollmentConfig) { c.Distribution = "phone" },
		func(c *enrollmentConfig) { c.Signer = "" }, func(c *enrollmentConfig) { c.RootHash = string(bytes.Repeat([]byte("b"), 64)) },
		func(c *enrollmentConfig) { c.MetadataBase = "http://updates.example.com/" }, func(c *enrollmentConfig) { c.MetadataBase = "https://unapproved.example.com/" },
		func(c *enrollmentConfig) { c.MetadataBase = "https://updates.example.com/../metadata/" }, func(c *enrollmentConfig) { c.MetadataBase = "https://user:secret@updates.example.com/" },
		func(c *enrollmentConfig) { c.Hosts = []string{"127.0.0.1"} }, func(c *enrollmentConfig) { c.Hosts = []string{"host.local"} }, func(c *enrollmentConfig) { c.Hosts = []string{"updates.example.com", "updates.example.com"} },
	} {
		var config enrollmentConfig
		if e := json.Unmarshal(c, &config); e != nil {
			t.Fatal(e)
		}
		mutate(&config)
		bad, _ := json.Marshal(config)
		if e := InitializeEnrollment(enrollmentDirectory(t), bad, r); e == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	duplicate := append([]byte(`{"schemaVersion":1,`), c[1:]...)
	if e := InitializeEnrollment(enrollmentDirectory(t), duplicate, r); e == nil {
		t.Fatal("duplicate accepted")
	}
	for _, badRoot := range [][]byte{nil, []byte(`{}`), append([]byte(nil), r...)} {
		if len(badRoot) > 10 {
			badRoot[len(badRoot)/2] ^= 1
		}
		if e := InitializeEnrollment(enrollmentDirectory(t), c, badRoot); e == nil {
			t.Fatal("invalid root accepted")
		}
	}
}
func TestEnrollmentRejectsStorageTampering(t *testing.T) {
	c, r := enrollmentFixture(t)
	for _, mode := range []string{"corrupt", "symlink", "partial", "missing-marker", "permissions", "unknown-field"} {
		t.Run(mode, func(t *testing.T) {
			dir := enrollmentDirectory(t)
			if e := InitializeEnrollment(dir, c, r); e != nil {
				t.Fatal(e)
			}
			file := filepath.Join(dir, "enrollment.json")
			switch mode {
			case "corrupt":
				data, _ := os.ReadFile(file)
				data[len(data)/2] ^= 1
				os.WriteFile(file, data, 0600)
			case "symlink":
				other := filepath.Join(enrollmentDirectory(t), "copy")
				data, _ := os.ReadFile(file)
				os.WriteFile(other, data, 0600)
				os.Remove(file)
				os.Symlink(other, file)
			case "partial":
				os.WriteFile(filepath.Join(dir, "enrollment.next"), []byte("partial"), 0600)
			case "missing-marker":
				os.Remove(filepath.Join(dir, "initialized"))
			case "permissions":
				os.Chmod(file, 0644)
			case "unknown-field":
				data, _ := os.ReadFile(file)
				data = append([]byte(`{"unknown":true,`), data[1:]...)
				os.WriteFile(file, data, 0600)
			}
			if _, e := ReadEnrollment(dir); e == nil {
				t.Fatal("unsafe enrollment accepted")
			}
			if e := InitializeEnrollment(dir, c, r); e == nil {
				t.Fatal("unsafe enrollment replaced")
			}
		})
	}
}
func TestEnrollmentConcurrentInitialization(t *testing.T) {
	c, r := enrollmentFixture(t)
	dir := enrollmentDirectory(t)
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- InitializeEnrollment(dir, c, r) }()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("initialization count", success)
	}
	if _, e := ReadEnrollment(dir); e != nil {
		t.Fatal(e)
	}
}
func TestEnrollmentProcessDeath(t *testing.T) {
	if directory := os.Getenv("OTA_ENROLLMENT_CHILD"); directory != "" {
		c, _ := os.ReadFile(filepath.Join(directory, "../config"))
		r, _ := os.ReadFile(filepath.Join(directory, "../root"))
		initializeEnrollment(directory, c, r, func(point string) {
			if point == os.Getenv("OTA_ENROLLMENT_BOUNDARY") {
				os.Exit(24)
			}
		})
		os.Exit(25)
	}
	c, r := enrollmentFixture(t)
	for _, boundary := range []string{"before-sync", "before-rename", "published"} {
		t.Run(boundary, func(t *testing.T) {
			root := enrollmentDirectory(t)
			directory := filepath.Join(root, "state")
			os.Mkdir(directory, 0700)
			os.WriteFile(filepath.Join(root, "config"), c, 0600)
			os.WriteFile(filepath.Join(root, "root"), r, 0600)
			cmd := exec.Command(os.Args[0], "-test.run=^TestEnrollmentProcessDeath$")
			cmd.Env = append(os.Environ(), "OTA_ENROLLMENT_CHILD="+directory, "OTA_ENROLLMENT_BOUNDARY="+boundary)
			err := cmd.Run()
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 24 {
				t.Fatal(err)
			}
			_, err = ReadEnrollment(directory)
			if (err == nil) != (boundary == "published") {
				t.Fatal("unexpected interrupted state", err)
			}
			if e := InitializeEnrollment(directory, c, r); e == nil {
				t.Fatal("interrupted enrollment reset")
			}
		})
	}
}

func enrollmentDirectory(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if e := os.Chmod(dir, 0700); e != nil {
		t.Fatal(e)
	}
	return dir
}

func TestEnrollmentValidatesPinnedRootStructure(t *testing.T) {
	c, r := enrollmentFixture(t)
	for _, mode := range []string{"unsigned", "threshold", "missing-role", "inconsistent"} {
		t.Run(mode, func(t *testing.T) {
			var object map[string]any
			json.Unmarshal(r, &object)
			signed := object["signed"].(map[string]any)
			switch mode {
			case "unsigned":
				object["signatures"] = []any{}
			case "threshold":
				signed["roles"].(map[string]any)["root"].(map[string]any)["threshold"] = 2
			case "missing-role":
				delete(signed["roles"].(map[string]any), "timestamp")
			case "inconsistent":
				signed["consistent_snapshot"] = false
			}
			changed, _ := json.Marshal(object)
			sum := sha256.Sum256(changed)
			var config enrollmentConfig
			json.Unmarshal(c, &config)
			config.RootHash = hex.EncodeToString(sum[:])
			input, _ := json.Marshal(config)
			if e := InitializeEnrollment(enrollmentDirectory(t), input, changed); e == nil {
				t.Fatal("invalid self-consistent root pin accepted")
			}
		})
	}
}
