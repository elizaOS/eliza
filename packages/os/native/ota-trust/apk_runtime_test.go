package otatrust

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/base64"
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
	return runtimeAPKFixtureForABI(t, mutation, "arm64-v8a")
}
func runtimeAPKFixtureForABI(t *testing.T, mutation, abi string) (string, []byte) {
	t.Helper()
	v := admissionVectors(t)[0]
	var release releaseDescriptor
	if err := json.Unmarshal(v.Release, &release); err != nil {
		t.Fatal(err)
	}
	a := release.Candidate
	a.Android.ABIs = []string{abi}
	machine, otherMachine, loader := uint16(183), uint16(62), "libeliza_ld_musl_aarch64.so"
	if abi == "x86_64" {
		machine, otherMachine, loader = 62, 183, "libeliza_ld_musl_x86_64.so"
	}
	bunPath := "lib/" + abi + "/libeliza_bun.so"
	loaderPath := "lib/" + abi + "/" + loader
	assets := map[string][]byte{"assets/agent/agent-bundle.js": []byte("agent"), "assets/agent/gateway/local-agent-gateway.mjs": []byte("gateway"), "assets/agent/gateway/task-runtime.mjs": []byte("policy"), "assets/agent/gateway/bootstrap.mjs": []byte("bootstrap"), bunPath: fixtureELF(machine), loaderPath: fixtureELF(machine)}
	if mutation == "mixed-loaders" {
		other := "libeliza_ld_musl_x86_64.so"
		if abi == "x86_64" {
			other = "libeliza_ld_musl_aarch64.so"
		}
		assets["lib/"+abi+"/"+other] = fixtureELF(machine)
	}
	if mutation == "empty-agent" {
		assets["assets/agent/agent-bundle.js"] = []byte{}
	}
	if mutation == "wrong-native-abi" {
		assets[bunPath] = fixtureELF(otherMachine)
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
	host, err := requiredHostPolicy()
	if err != nil {
		t.Fatal(err)
	}
	inventory := []byte(host.RuntimeInventoryHeader + "\n" + strings.Join(rows, "\n") + "\n")
	a.Runtime.Inventory = bytesHash(inventory)
	assets[runtimeInventoryAsset] = inventory
	switch mutation {
	case "unlisted":
		assets["assets/agent/unlisted.js"] = []byte("unexpected")
	case "missing-file":
		delete(assets, "assets/agent/agent-bundle.js")
	case "wrong-agent":
		assets["assets/agent/agent-bundle.js"] = []byte("wrong")
	case "wrong-library":
		assets[bunPath] = []byte("wrong-runtime!")
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
		for _, mutation := range []string{"valid", "mixed-loaders", "empty-agent", "wrong-native-abi", "unlisted", "missing-file", "wrong-agent", "wrong-library", "wrong-inventory", "wrong-policy", "extra-library", "duplicate-zip", "duplicate-destination", "traversal", "wrong-apk", "directory-count"} {
			t.Run(abi+"/"+mutation, func(t *testing.T) {
				name, artifact := runtimeAPKFixtureForABI(t, mutation, abi)
				err := VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", abi)
				if mutation == "valid" {
					if err != nil {
						t.Fatal(err)
					}
					other := "x86_64"
					if abi == "x86_64" {
						other = "arm64-v8a"
					}
					if err = VerifyRuntimeArtifact(name, artifact, "github.com,updates.example.com", other); err == nil {
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
				if entry.Name == runtimeInventoryAsset {
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

// packagedRuntimeAPK zips testdata/runtime-apk, whose inventory and blobs were
// written by plugin-native-agent's stageAndroidRuntimeInventory (the plugin's
// native-host suite fails if they drift). Ignored packager inputs are restored:
// the original archive (the blob's bytes) and an excluded model directory.
func packagedRuntimeAPK(t *testing.T, mutate func(map[string][]byte)) string {
	t.Helper()
	root := filepath.Join("testdata", "runtime-apk")
	files := map[string][]byte{}
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
	for name, data := range files {
		if strings.HasPrefix(name, "assets/runtime-blobs/") {
			files["assets/agent/extension.tar.gz"] = data
		}
	}
	files["assets/agent/models/model.bin"] = []byte("excluded synthetic model read directly from assets\n")
	if mutate != nil {
		mutate(files)
	}
	return writeRuntimeAPK(t, files)
}

func writeRuntimeAPK(t *testing.T, files map[string][]byte) string {
	t.Helper()
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
	verify := func(apk string) error {
		metadata, err := json.Marshal(preparationArtifact(t, apk, release.Candidate))
		if err != nil {
			t.Fatal(err)
		}
		return VerifyRuntimeArtifact(apk, metadata, "github.com,updates.example.com", "arm64-v8a")
	}
	if err := verify(packagedRuntimeAPK(t, nil)); err != nil {
		t.Fatalf("packager-produced runtime rejected: %v", err)
	}
	for name, mutate := range map[string]func(map[string][]byte){
		"legacy-inventory-path": func(files map[string][]byte) {
			files["assets/runtime-payload.tsv"] = files[runtimeInventoryAsset]
			delete(files, runtimeInventoryAsset)
		},
		"unlisted-agent-file": func(files map[string][]byte) { files["assets/agent/gateway/extra.mjs"] = []byte("unlisted") },
		"unlisted-blob": func(files map[string][]byte) {
			files["assets/runtime-blobs/"+strings.Repeat("0", 64)+".bin"] = []byte("unlisted")
		},
		"archive-without-blob": func(files map[string][]byte) { files["assets/agent/other.tar"] = []byte("unlisted") },
		"excluded-prefix-only": func(files map[string][]byte) { files["assets/agent/models.txt"] = []byte("not excluded") },
		"tampered-listed-asset": func(files map[string][]byte) {
			files["assets/agent/gateway/bootstrap.mjs"] = []byte("synthetic bootstrap?")
		},
	} {
		t.Run(name, func(t *testing.T) {
			apk := packagedRuntimeAPK(t, mutate)
			if name == "tampered-listed-asset" || name == "legacy-inventory-path" {
				// Expectations come from the untampered inventory, as a signed release would.
				metadata, _ := json.Marshal(preparationArtifact(t, packagedRuntimeAPK(t, nil), release.Candidate))
				var artifact releaseArtifact
				json.Unmarshal(metadata, &artifact)
				data, _ := os.ReadFile(apk)
				artifact.SHA256, artifact.Length = bytesHash(data), int64(len(data))
				metadata, _ = json.Marshal(artifact)
				if err := VerifyRuntimeArtifact(apk, metadata, "github.com,updates.example.com", "arm64-v8a"); err == nil {
					t.Fatal("altered packaged runtime accepted")
				}
				return
			}
			if err := verify(apk); err == nil {
				t.Fatal("unlisted packaged runtime asset accepted")
			}
		})
	}
	saved := compiledHostPolicyBase64
	defer func() { compiledHostPolicyBase64 = saved }()
	for name, change := range map[string]func(*hostPolicy){
		"other-header":      func(p *hostPolicy) { p.RuntimeInventoryHeader = "independent-runtime-v1" },
		"models-not-exempt": func(p *hostPolicy) { p.RuntimeExcludedAgentDirectories = []string{} },
	} {
		t.Run(name, func(t *testing.T) {
			compiledHostPolicyBase64 = saved
			policy, err := requiredHostPolicy()
			if err != nil {
				t.Fatal(err)
			}
			change(&policy)
			data, _ := json.Marshal(policy)
			compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString(data)
			if err = verify(packagedRuntimeAPK(t, nil)); err == nil {
				t.Fatal("runtime accepted outside host policy")
			}
		})
	}
}

func TestReaddressedArchive(t *testing.T) {
	destinations := map[string]string{"vector.tar.gz": strings.Repeat("a", 64), "bundle/plain.js": strings.Repeat("b", 64)}
	for name, want := range map[string]bool{"vector.tar": true, "nested/vector.tar": true, "vector.tar.gz": true, "other.tar": false, "plain.js": false, "vector.tar.gz.bak": false} {
		if readdressedArchive(name, destinations) != want {
			t.Fatalf("%s: want %v", name, want)
		}
	}
}

func TestNodeRuntimeInventoryForCompiledHost(t *testing.T) {
	const abi = "arm64-v8a"
	const hosts = "github.com,updates.example.com"
	const library = "lib/arm64-v8a/" + nodeLibraryName

	var release releaseDescriptor
	if err := json.Unmarshal(admissionVectors(t)[0].Release, &release); err != nil {
		t.Fatal(err)
	}
	legacyAPK, legacyReceipt := runtimeAPKFixture(t, "")
	legacy := compiledHostPolicyBase64
	t.Cleanup(func() { compiledHostPolicyBase64 = legacy })
	compiledHostPolicyBase64 = base64.RawURLEncoding.EncodeToString([]byte(`{"schema":3,"product":"example-app","package":"com.example.app","cohortDomain":"example-app-ota-v1"}`))
	if err := VerifyRuntimeArtifact(legacyAPK, legacyReceipt, hosts, abi); err == nil {
		t.Fatal("Node host admitted a Bun receipt")
	}

	artifactFor := func(t *testing.T, files map[string][]byte, excluded string) (string, releaseArtifact) {
		t.Helper()
		inventory := struct {
			Schema int64              `json:"schema"`
			Files  []nodeInventoryRow `json:"files"`
		}{Schema: 1}
		for name, data := range files {
			if name != excluded {
				inventory.Files = append(inventory.Files, nodeInventoryRow{Path: name, SHA256: bytesHash(data), Size: int64(len(data))})
			}
		}
		sort.Slice(inventory.Files, func(i, j int) bool { return inventory.Files[i].Path < inventory.Files[j].Path })
		bytes, err := json.Marshal(inventory)
		if err != nil {
			t.Fatal(err)
		}
		files[nodeInventoryAsset] = bytes
		apk := writeRuntimeAPK(t, files)
		binary, err := os.ReadFile(apk)
		if err != nil {
			t.Fatal(err)
		}
		artifact := release.Candidate
		artifact.Android.ABIs = []string{abi}
		artifact.SHA256 = bytesHash(binary)
		artifact.Length = int64(len(binary))
		artifact.Runtime = releaseRuntime{Inventory: bytesHash(bytes), Agent: bytesHash(files[nodeBundleAsset]), Libraries: map[string]string{library: bytesHash(files[library])}}
		return apk, artifact
	}
	runtimeFiles := func() map[string][]byte {
		node := append(fixtureELF(nodeMachines[abi]), []byte(androidInterpreter)...)
		binary.LittleEndian.PutUint16(node[16:18], 3)
		binary.LittleEndian.PutUint32(node[64:68], 3)
		binary.LittleEndian.PutUint64(node[72:80], 120)
		binary.LittleEndian.PutUint64(node[96:104], uint64(len(androidInterpreter)))
		agent := []byte("console.log('synthetic embedded Node runtime')\n")
		manifest := fmt.Appendf(nil, `{"schema":1,"node":"26","bundleSha256":%q,"sourceCommit":%q,"localInference":false}`, bytesHash(agent), strings.Repeat("a", 40))
		return map[string][]byte{
			nodeBundleAsset: agent, nodeManifestAsset: manifest, library: node,
			"assets/agent/pglite.wasm": []byte("synthetic wasm"), "assets/agent/initdb.wasm": []byte("synthetic initdb"),
			"assets/agent/pglite.data": []byte("synthetic data"), "assets/agent/pglite-migrated.bin": []byte("synthetic migrated database"),
		}
	}
	verify := func(t *testing.T, apk string, artifact releaseArtifact) error {
		t.Helper()
		receipt, err := json.Marshal(artifact)
		if err != nil {
			t.Fatal(err)
		}
		return VerifyRuntimeArtifact(apk, receipt, hosts, abi)
	}

	name, artifact := artifactFor(t, runtimeFiles(), "")
	if err := verify(t, name, artifact); err != nil {
		t.Fatalf("complete Node runtime refused: %v", err)
	}
	mixed := artifact
	mixed.Runtime.Gateway = strings.Repeat("a", 64)
	mixed.Runtime.Policy = strings.Repeat("b", 64)
	if err := verify(t, name, mixed); err == nil {
		t.Fatal("Node host admitted Bun runtime claims")
	}
	for _, vacancy := range []string{"assets/agent/pglite.wasm", "assets/agent/initdb.wasm", "assets/agent/pglite.data", "assets/agent/pglite-migrated.bin"} {
		t.Run(vacancy, func(t *testing.T) {
			files := runtimeFiles()
			delete(files, vacancy)
			files["assets/agent/another.mjs"] = []byte("different content in the same listed asset tree")
			apk, incomplete := artifactFor(t, files, "")
			if err := verify(t, apk, incomplete); err == nil || err.Error() != "Node runtime inventory is incomplete" {
				t.Fatalf("missing required asset produced: %v", err)
			}
		})
	}
	t.Run("refuse an executable for another loader", func(t *testing.T) {
		files := runtimeFiles()
		files[library][121] = 'x'
		apk, other := artifactFor(t, files, "")
		if err := verify(t, apk, other); err == nil || err.Error() != "Node executable does not use the Android linker" {
			t.Fatalf("different executable interpreter produced: %v", err)
		}
	})
	t.Run("refuse a manifest without the exact Node version field", func(t *testing.T) {
		files := runtimeFiles()
		files[nodeManifestAsset] = []byte(strings.Replace(string(files[nodeManifestAsset]), `"node"`, `"NODE"`, 1))
		apk, other := artifactFor(t, files, "")
		if err := verify(t, apk, other); err == nil || err.Error() != "Node bundle manifest does not bind the executable bundle" {
			t.Fatalf("incorrect manifest produced: %v", err)
		}
	})
	t.Run("refuse an omitted Agent asset", func(t *testing.T) {
		files := runtimeFiles()
		files["assets/agent/extra.mjs"] = []byte("unlisted")
		apk, other := artifactFor(t, files, "assets/agent/extra.mjs")
		if err := verify(t, apk, other); err == nil || err.Error() != "unlisted Node runtime file" {
			t.Fatalf("mixed runtime contents produced: %v", err)
		}
	})
	compiledHostPolicyBase64 = legacy
	if err := VerifyRuntimeArtifact(legacyAPK, legacyReceipt, hosts, abi); err != nil {
		t.Fatalf("historical Bun receipt refused: %v", err)
	}
	if err := verify(t, name, artifact); err == nil {
		t.Fatal("Bun host admitted a Node receipt")
	}
}
