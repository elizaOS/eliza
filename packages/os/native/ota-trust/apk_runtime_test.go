// spec/os/build/runtimePayload.md, "The APK carries exactly one Node runtime for each targeted ABI and none for another"; spec/os/build/runtimePayload.md, "The inventory lists every staged payload file once, by digest and size, and nothing else"
package otatrust

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type fixtureRow struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

func bytesHash(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

func otherRuntimeABI(abi string) string {
	if abi == "x86_64" {
		return "arm64-v8a"
	}
	return "x86_64"
}

func fixtureInventory(t *testing.T, files map[string][]byte, listed []string) []byte {
	t.Helper()
	rows := []fixtureRow{}
	for _, name := range listed {
		rows = append(rows, fixtureRow{name, bytesHash(files[name]), len(files[name])})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Path < rows[j].Path })
	data, err := json.MarshalIndent(struct {
		Schema int          `json:"schema"`
		Files  []fixtureRow `json:"files"`
	}{1, rows}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(data, '\n')
}

func runtimeAPKFixture(t *testing.T, mutation string) (string, []byte) {
	return runtimeAPKFixtureForABIs(t, mutation, []string{"arm64-v8a"})
}

func runtimeAPKFixtureForABIs(t *testing.T, mutation string, abis []string) (string, []byte) {
	t.Helper()
	var release releaseDescriptor
	if err := json.Unmarshal(admissionVectors(t)[0].Release, &release); err != nil {
		t.Fatal(err)
	}
	a := release.Candidate
	a.Android.ABIs = abis
	abi := abis[0]
	node := "lib/" + abi + "/" + nodeLibraryName
	files := map[string][]byte{
		agentBundleAsset:           []byte("export {};\n"),
		bundleManifestAsset:        []byte(`{"schema":1}`),
		"assets/host/notice.txt":   []byte("consumer asset\n"),
		"classes.dex":              []byte("host code outside the payload"),
		"assets/public/index.html": []byte("host page outside the payload"),
	}
	for _, target := range abis {
		files["lib/"+target+"/"+nodeLibraryName] = fixtureELF(runtimeMachines[target])
	}
	extra := map[string]string{
		"musl-loader":        "lib/" + abi + "/libeliza_ld_musl_aarch64.so",
		"bun-runtime":        "lib/" + abi + "/libeliza_bun.so",
		"gateway-file":       "assets/agent/gateway/local-agent-gateway.mjs",
		"second-abi-runtime": "lib/" + otherRuntimeABI(abi) + "/" + nodeLibraryName,
		"zero-size":          "assets/agent/empty.js",
	}[mutation]
	if extra != "" {
		files[extra] = fixtureELF(runtimeMachines[abi])
		if mutation == "gateway-file" {
			files[extra] = []byte("gateway")
		}
		if mutation == "second-abi-runtime" {
			files[extra] = fixtureELF(runtimeMachines[otherRuntimeABI(abi)])
		}
		if mutation == "zero-size" {
			files[extra] = []byte{}
		}
	}
	if mutation == "wrong-native-abi" {
		files[node] = fixtureELF(runtimeMachines[otherRuntimeABI(abi)])
	}
	listed := []string{}
	for name := range files {
		if strings.HasPrefix(name, "lib/") || strings.HasPrefix(name, "assets/agent/") || strings.HasPrefix(name, "assets/host/") {
			if !(mutation == "missing-node" && name == node) {
				listed = append(listed, name)
			}
		}
	}
	if mutation == "missing-node" {
		delete(files, node)
	}
	a.Runtime.Agent = bytesHash(files[agentBundleAsset])
	a.Runtime.Libraries = map[string]string{}
	for _, name := range listed {
		if strings.HasPrefix(name, "lib/") {
			a.Runtime.Libraries[name] = bytesHash(files[name])
		}
	}
	inventory := fixtureInventory(t, files, listed)
	switch mutation {
	case "duplicate-row":
		inventory = bytes.Replace(inventory, []byte(`"files": [`), []byte(`"files": [{"path":"`+agentBundleAsset+`","sha256":"`+bytesHash(files[agentBundleAsset])+`","size":11},`), 1)
	case "traversal":
		inventory = bytes.Replace(inventory, []byte(`"assets/host/notice.txt"`), []byte(`"assets/host/../host/notice.txt"`), 1)
	case "unknown-field":
		inventory = bytes.Replace(inventory, []byte(`"size":`), []byte(`"extra": 1, "size":`), 1)
	case "old-inventory":
		inventory = []byte("eliza-runtime-v1\nasset\t11\t" + bytesHash(files[agentBundleAsset]) + "\tagent/agent.mjs\tbundle/agent.mjs\n")
	}
	files[runtimeInventoryAsset] = inventory
	a.Runtime.Inventory = bytesHash(inventory)
	switch mutation {
	case "unlisted-gateway":
		files["assets/agent/gateway/bootstrap.mjs"] = []byte("bootstrap")
	case "unlisted-library":
		files["lib/"+abi+"/libextra.so"] = fixtureELF(runtimeMachines[abi])
	case "unlisted-asset":
		files["assets/agent/unlisted.js"] = []byte("unexpected")
	case "unlisted-consumer-asset":
		files["assets/host/extra.txt"] = []byte("unexpected")
	case "missing-file":
		delete(files, agentBundleAsset)
	case "wrong-agent":
		files[agentBundleAsset] = []byte("export {}; \n")
	case "wrong-library":
		files[node] = append(fixtureELF(runtimeMachines[abi])[:119], 1)
	case "wrong-inventory":
		a.Runtime.Inventory = strings.Repeat("0", 64)
	case "wrong-agent-declaration":
		a.Runtime.Agent = strings.Repeat("0", 64)
	case "extra-library":
		a.Runtime.Libraries["lib/"+abi+"/libother.so"] = strings.Repeat("0", 64)
	}
	name := filepath.Join(t.TempDir(), "fixture.apk")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, data := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if mutation == "duplicate-zip" {
		entry, _ := writer.Create(runtimeInventoryAsset)
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
	for _, abi := range []string{"arm64-v8a", "x86_64"} {
		for _, mutation := range []string{"valid", "musl-loader", "bun-runtime", "gateway-file", "unlisted-gateway", "second-abi-runtime", "zero-size", "wrong-native-abi", "missing-node", "unlisted-library", "unlisted-asset", "unlisted-consumer-asset", "missing-file", "wrong-agent", "wrong-library", "wrong-inventory", "wrong-agent-declaration", "extra-library", "duplicate-zip", "duplicate-row", "traversal", "unknown-field", "old-inventory", "wrong-apk", "directory-count"} {
			t.Run(abi+"/"+mutation, func(t *testing.T) {
				name, artifact := runtimeAPKFixtureForABIs(t, mutation, []string{abi})
				err := VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", abi)
				if mutation == "valid" {
					if err != nil {
						t.Fatal(err)
					}
					if err = VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", otherRuntimeABI(abi)); err == nil {
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
}

func TestPackagedRuntimeForEveryTargetedABI(t *testing.T) {
	abis := []string{"arm64-v8a", "x86_64"}
	name, artifact := runtimeAPKFixtureForABIs(t, "valid", abis)
	for _, abi := range abis {
		if err := VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", abi); err != nil {
			t.Fatalf("%s: %v", abi, err)
		}
	}
	name, artifact = runtimeAPKFixtureForABIs(t, "missing-node", abis)
	for _, abi := range abis {
		if err := VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", abi); err == nil {
			t.Fatalf("%s: runtime missing for a targeted ABI accepted", abi)
		}
	}
}

func TestActualPackagedRuntime(t *testing.T) {
	directory := os.Getenv("OTA_NATIVE_APK_DIRECTORY")
	if directory == "" {
		t.Skip("native APK directory not supplied")
	}
	var release releaseDescriptor
	if err := json.Unmarshal(admissionVectors(t)[0].Release, &release); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"launcher", "standalone"} {
		t.Run(variant, func(t *testing.T) {
			name := filepath.Join(directory, variant+"-release-unsigned.apk")
			a := preparationArtifact(t, name, release.Candidate)
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
	binary.LittleEndian.PutUint16(b[16:18], 3)
	binary.LittleEndian.PutUint16(b[18:20], machine)
	binary.LittleEndian.PutUint32(b[20:24], 1)
	binary.LittleEndian.PutUint64(b[32:40], 64)
	binary.LittleEndian.PutUint16(b[52:54], 64)
	binary.LittleEndian.PutUint16(b[54:56], 56)
	binary.LittleEndian.PutUint16(b[56:58], 1)
	return b
}

func packagedRuntimeAPK(t *testing.T, mutate func(map[string][]byte)) string {
	t.Helper()
	root := filepath.Join("testdata", "runtime-apk")
	files := map[string][]byte{"classes.dex": []byte("host code outside the payload")}
	err := filepath.WalkDir(root, func(name string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(name)
		relative, _ := filepath.Rel(root, name)
		files[filepath.ToSlash(relative)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if mutate != nil {
		mutate(files)
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	apk := filepath.Join(t.TempDir(), "packaged.apk")
	file, err := os.Create(apk)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err == nil {
			_, err = entry.Write(files[name])
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	return apk
}

func TestPackagerProducedRuntimeInventory(t *testing.T) {
	var release releaseDescriptor
	if err := json.Unmarshal(admissionVectors(t)[0].Release, &release); err != nil {
		t.Fatal(err)
	}
	expected := preparationArtifact(t, packagedRuntimeAPK(t, nil), release.Candidate)
	verify := func(apk string) error {
		data, err := os.ReadFile(apk)
		if err != nil {
			t.Fatal(err)
		}
		artifact := expected
		artifact.SHA256, artifact.Length = bytesHash(data), int64(len(data))
		metadata, err := json.Marshal(artifact)
		if err != nil {
			t.Fatal(err)
		}
		return VerifyRuntimeArtifact(apk, metadata, "github.com,updates.example.com", "arm64-v8a")
	}
	if err := verify(packagedRuntimeAPK(t, nil)); err != nil {
		t.Fatalf("staged runtime payload rejected: %v", err)
	}
	for name, mutate := range map[string]func(map[string][]byte){
		"legacy-inventory-path": func(files map[string][]byte) {
			files["assets/agent-runtime.inventory"] = files[runtimeInventoryAsset]
			delete(files, runtimeInventoryAsset)
		},
		"unlisted-agent-file":   func(files map[string][]byte) { files["assets/agent/extra.mjs"] = []byte("unlisted") },
		"unlisted-library":      func(files map[string][]byte) { files["lib/arm64-v8a/libextra.so"] = fixtureELF(183) },
		"gateway-bootstrap":     func(files map[string][]byte) { files["assets/agent/gateway/bootstrap.mjs"] = []byte("bootstrap") },
		"tampered-listed-asset": func(files map[string][]byte) { files["assets/agent/pglite.data"] = []byte("synthetic pglite dat?\n") },
	} {
		t.Run(name, func(t *testing.T) {
			if err := verify(packagedRuntimeAPK(t, mutate)); err == nil {
				t.Fatal("altered packaged runtime accepted")
			}
		})
	}
}
