package otatrust

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func bytesHash(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func runtimeAPKFixture(t *testing.T, mutation string) (string, []byte) {
	t.Helper()
	v := admissionVectors(t)[0]
	var release releaseDescriptor
	if err := json.Unmarshal(v.Release, &release); err != nil {
		t.Fatal(err)
	}
	a := release.Candidate
	assets := map[string][]byte{"assets/agent/agent-bundle.js": []byte("agent"), "assets/agent/gateway/local-agent-gateway.mjs": []byte("gateway"), "assets/agent/gateway/task-runtime.mjs": []byte("policy"), "assets/agent/gateway/bootstrap.mjs": []byte("bootstrap"), "lib/arm64-v8a/libeliza_bun.so": fixtureELF(183), "lib/arm64-v8a/libeliza_ld_musl_aarch64.so": fixtureELF(183)}
	if mutation == "empty-agent" {
		assets["assets/agent/agent-bundle.js"] = []byte{}
	}
	if mutation == "wrong-native-abi" {
		assets["lib/arm64-v8a/libeliza_bun.so"] = fixtureELF(62)
	}
	a.Runtime.Agent = bytesHash(assets["assets/agent/agent-bundle.js"])
	a.Runtime.Gateway = bytesHash(assets["assets/agent/gateway/local-agent-gateway.mjs"])
	a.Runtime.Policy = bytesHash(assets["assets/agent/gateway/task-runtime.mjs"])
	a.Runtime.Libraries = map[string]string{}
	var rows []string
	for name, data := range assets {
		if strings.HasPrefix(name, "lib/") {
			lib := filepath.Base(name)
			a.Runtime.Libraries[lib] = bytesHash(data)
			rows = append(rows, fmt.Sprintf("native\t%d\t%s\t%s\t-", len(data), bytesHash(data), lib))
		} else {
			source := strings.TrimPrefix(name, "assets/")
			destination := "bundle/" + strings.TrimPrefix(source, "agent/")
			rows = append(rows, fmt.Sprintf("asset\t%d\t%s\t%s\t%s", len(data), bytesHash(data), source, destination))
		}
	}
	sort.Strings(rows)
	if mutation == "duplicate-destination" {
		rows = append(rows, rows[0])
	}
	if mutation == "traversal" {
		rows[0] = strings.Replace(rows[0], "agent/", "agent/../", 1)
	}
	inventory := []byte("senior-care-runtime-v1\n" + strings.Join(rows, "\n") + "\n")
	a.Runtime.Inventory = bytesHash(inventory)
	assets["assets/runtime-payload.tsv"] = inventory
	switch mutation {
	case "unlisted":
		assets["assets/agent/unlisted.js"] = []byte("unexpected")
	case "missing-file":
		delete(assets, "assets/agent/agent-bundle.js")
	case "wrong-agent":
		assets["assets/agent/agent-bundle.js"] = []byte("wrong")
	case "wrong-library":
		assets["lib/arm64-v8a/libeliza_bun.so"] = []byte("wrong-runtime!")
	case "wrong-inventory":
		a.Runtime.Inventory = strings.Repeat("0", 64)
	case "wrong-policy":
		a.Runtime.Policy = strings.Repeat("0", 64)
	case "extra-library":
		a.Runtime.Libraries["libother.so"] = strings.Repeat("0", 64)
	}
	name := filepath.Join(t.TempDir(), "fixture.apk")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, data := range assets {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if mutation == "duplicate-zip" {
		entry, _ := writer.Create("assets/runtime-payload.tsv")
		entry.Write(inventory)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	file.Close()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	a.SHA256 = bytesHash(data)
	a.Length = int64(len(data))
	if mutation == "wrong-apk" {
		a.SHA256 = strings.Repeat("0", 64)
	}
	if mutation == "directory-count" {
		data[len(data)-12] = 1
		data[len(data)-14] = 1
		os.WriteFile(name, data, 0600)
		a.SHA256 = bytesHash(data)
	}
	artifact, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	return name, artifact
}
func TestPackagedRuntimeVerification(t *testing.T) {
	for _, mutation := range []string{"valid", "empty-agent", "wrong-native-abi", "unlisted", "missing-file", "wrong-agent", "wrong-library", "wrong-inventory", "wrong-policy", "extra-library", "duplicate-zip", "duplicate-destination", "traversal", "wrong-apk", "directory-count"} {
		t.Run(mutation, func(t *testing.T) {
			name, artifact := runtimeAPKFixture(t, mutation)
			err := VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", "arm64-v8a")
			if mutation == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				if err = VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", "x86_64"); err == nil {
					t.Fatal("unqualified ABI accepted")
				}
				return
			}
			if err == nil {
				t.Fatal("unsafe packaged runtime accepted")
			}
		})
	}
}

// Opt-in inspection of retained real native APKs. Expectations are derived from
// the packaged inventory for consistency testing; this is not release signing.
func TestActualPackagedRuntime(t *testing.T) {
	directory := os.Getenv("OTA_NATIVE_APK_DIRECTORY")
	if directory == "" {
		t.Skip("native APK directory not supplied")
	}
	for _, variant := range []string{"launcher", "standalone"} {
		t.Run(variant, func(t *testing.T) {
			name := filepath.Join(directory, variant+"-release-unsigned.apk")
			archive, err := zip.OpenReader(name)
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			var inventory []byte
			for _, entry := range archive.File {
				if entry.Name == "assets/runtime-payload.tsv" {
					inventory, err = readAPKEntry(entry, 2*1024*1024)
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			if inventory == nil {
				t.Fatal("inventory absent")
			}
			var d releaseDescriptor
			if err = json.Unmarshal(admissionVectors(t)[0].Release, &d); err != nil {
				t.Fatal(err)
			}
			a := d.Candidate
			a.Runtime.Inventory = bytesHash(inventory)
			a.Runtime.Libraries = map[string]string{}
			for _, line := range strings.Split(string(inventory), "\n")[1:] {
				fields := strings.Split(line, "\t")
				if len(fields) != 5 {
					continue
				}
				if fields[0] == "native" {
					a.Runtime.Libraries[fields[3]] = fields[2]
				}
				switch fields[4] {
				case "bundle/agent-bundle.js":
					a.Runtime.Agent = fields[2]
				case "bundle/gateway/local-agent-gateway.mjs":
					a.Runtime.Gateway = fields[2]
				case "bundle/gateway/task-runtime.mjs":
					a.Runtime.Policy = fields[2]
				}
			}
			file, err := os.Open(name)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.New()
			a.Length, err = io.Copy(hash, file)
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			a.SHA256 = hex.EncodeToString(hash.Sum(nil))
			metadata, err := json.Marshal(a)
			if err != nil {
				t.Fatal(err)
			}
			if err = VerifyRuntimeArtifact(name, metadata, "github.com,updates.example.com", "arm64-v8a"); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s sha256=%s bytes=%d", variant, a.SHA256, a.Length)
		})
	}
}

func fixtureELF(machine uint16) []byte {
	b := make([]byte, 120)
	copy(b, []byte{0x7f, 'E', 'L', 'F', 2, 1, 1})
	binary.LittleEndian.PutUint16(b[16:18], 2)
	binary.LittleEndian.PutUint16(b[18:20], machine)
	binary.LittleEndian.PutUint32(b[20:24], 1)
	binary.LittleEndian.PutUint64(b[32:40], 64)
	binary.LittleEndian.PutUint16(b[52:54], 64)
	binary.LittleEndian.PutUint16(b[54:56], 56)
	binary.LittleEndian.PutUint16(b[56:58], 1)
	return b
}
