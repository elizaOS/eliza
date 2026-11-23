// spec/os/build/runtimePayload.md, "The APK carries exactly one Node runtime for each targeted ABI and none for another"; spec/os/build/runtimePayload.md, "The inventory lists every staged payload file once, by digest and size, and nothing else"
package otatrust

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const (
	nodeInventoryAsset   = "assets/agent/inventory.json"
	nodeBundleAsset      = "assets/agent/agent.mjs"
	nodeManifestAsset    = "assets/agent/manifest.json"
	nodeLibraryName      = "libeliza_node.so"
	androidInterpreter   = "/system/bin/linker64\x00"
	maxNodeInventory     = 2 * 1024 * 1024
	maxNodeInventoryRows = 16384
	maxNodeFileSize      = 512 * 1024 * 1024
	maxNodePayloadSize   = 2 * 1024 * 1024 * 1024
)

var nodeMachines = map[string]uint16{"arm64-v8a": 183, "x86_64": 62}

type nodeInventoryRow struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func nodeLibraryABI(name string) string {
	parts := strings.Split(name, "/")
	if len(parts) == 3 && parts[0] == "lib" && nodeMachines[parts[1]] != 0 &&
		matches(parts[2], `^lib[A-Za-z0-9_.+-]+\.so$`) &&
		!matches(parts[2], `^(libeliza_ld_[A-Za-z0-9_]+|libeliza_bun|ld-[A-Za-z0-9_.-]+)\.so$`) {
		return parts[1]
	}
	return ""
}

func nodeRuntimeDeclared(artifact releaseArtifact) bool {
	runtime := artifact.Runtime
	for name, digest := range runtime.Libraries {
		if abi := nodeLibraryABI(name); abi == "" || !contains(artifact.Android.ABIs, abi) || !validHex(digest) {
			return false
		}
	}
	for _, abi := range artifact.Android.ABIs {
		if runtime.Libraries["lib/"+abi+"/"+nodeLibraryName] == "" {
			return false
		}
	}
	return true
}

func readNodeInventory(entry *zip.File, expected string) ([]nodeInventoryRow, error) {
	if entry == nil {
		return nil, errors.New("Node runtime inventory missing")
	}
	data, err := readAPKEntry(entry, maxNodeInventory)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if !utf8.Valid(data) || checkJSON(data) != nil || hex.EncodeToString(sum[:]) != expected {
		return nil, errors.New("Node runtime inventory digest or encoding mismatch")
	}
	var document map[string]json.RawMessage
	var entries []map[string]json.RawMessage
	if json.Unmarshal(data, &document) != nil || len(document) != 2 ||
		!bytes.Equal(bytes.TrimSpace(document["schema"]), []byte("1")) ||
		json.Unmarshal(document["files"], &entries) != nil || len(entries) < 7 || len(entries) > maxNodeInventoryRows {
		return nil, errors.New("invalid Node runtime inventory")
	}
	rows := make([]nodeInventoryRow, 0, len(entries))
	for _, fields := range entries {
		var row nodeInventoryRow
		if len(fields) != 3 || json.Unmarshal(fields["path"], &row.Path) != nil ||
			json.Unmarshal(fields["sha256"], &row.SHA256) != nil || json.Unmarshal(fields["size"], &row.Size) != nil {
			return nil, errors.New("invalid Node runtime inventory row")
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func verifyNodeRuntime(entries map[string]*zip.File, artifact releaseArtifact) error {
	if entries[runtimeInventoryAsset] != nil {
		return errors.New("legacy runtime inventory present in Node APK")
	}
	rows, err := readNodeInventory(entries[nodeInventoryAsset], artifact.Runtime.Inventory)
	if err != nil {
		return err
	}
	listed := make(map[string]string, len(rows))
	natives := make(map[string]bool)
	trees := map[string]bool{"agent": true}
	var total int64
	for _, row := range rows {
		if !runtimePath(row.Path) || listed[row.Path] != "" || !validHex(row.SHA256) || row.Size < 0 || row.Size > maxNodeFileSize {
			return errors.New("invalid or duplicate Node runtime inventory row")
		}
		total += row.Size
		if total > maxNodePayloadSize {
			return errors.New("Node runtime payload too large")
		}
		entry := entries[row.Path]
		if entry == nil || entry.FileInfo().IsDir() || entry.UncompressedSize64 != uint64(row.Size) {
			return errors.New("packaged Node runtime file missing or wrong length")
		}
		parts := strings.SplitN(row.Path, "/", 3)
		switch {
		case parts[0] == "lib":
			abi := nodeLibraryABI(row.Path)
			if abi == "" || artifact.Runtime.Libraries[row.Path] != row.SHA256 {
				return errors.New("Node native library does not match the declaration")
			}
			if err = verifyRuntimeELF(entry, nodeMachines[abi]); err != nil {
				return err
			}
			if parts[2] == nodeLibraryName {
				if err = verifyNodeInterpreter(entry); err != nil {
					return err
				}
			}
			natives[row.Path] = true
		case parts[0] == "assets" && len(parts) == 3 && parts[1] != "runtime-blobs" && row.Path != nodeInventoryAsset:
			trees[parts[1]] = true
		default:
			return errors.New("invalid Node runtime inventory path")
		}
		if err = hashAPKEntry(entry, row.Size, row.SHA256); err != nil {
			return err
		}
		listed[row.Path] = row.SHA256
	}
	for name, entry := range entries {
		if entry.FileInfo().IsDir() || name == nodeInventoryAsset || listed[name] != "" {
			continue
		}
		parts := strings.SplitN(name, "/", 3)
		if parts[0] == "lib" || (parts[0] == "assets" && len(parts) == 3 && (trees[parts[1]] || parts[1] == "runtime-blobs")) {
			return errors.New("unlisted Node runtime file")
		}
	}
	if len(natives) != len(artifact.Runtime.Libraries) || listed[nodeBundleAsset] != artifact.Runtime.Agent {
		return errors.New("Node runtime or agent bundle does not match the declaration")
	}
	for _, required := range []string{nodeManifestAsset, "assets/agent/pglite.wasm", "assets/agent/initdb.wasm", "assets/agent/pglite.data", "assets/agent/pglite-migrated.bin"} {
		if listed[required] == "" {
			return errors.New("Node runtime inventory is incomplete")
		}
	}
	return verifyNodeBundleManifest(entries[nodeManifestAsset], artifact.Runtime.Agent)
}

func verifyNodeBundleManifest(entry *zip.File, agent string) error {
	data, err := readAPKEntry(entry, maxNodeInventory)
	if err != nil {
		return err
	}
	var manifest map[string]json.RawMessage
	var node, bundle, commit string
	if !utf8.Valid(data) || checkJSON(data) != nil || json.Unmarshal(data, &manifest) != nil ||
		!bytes.Equal(bytes.TrimSpace(manifest["schema"]), []byte("1")) ||
		json.Unmarshal(manifest["node"], &node) != nil || node != "26" ||
		json.Unmarshal(manifest["bundleSha256"], &bundle) != nil || bundle != agent ||
		json.Unmarshal(manifest["sourceCommit"], &commit) != nil || !matches(commit, `^[a-f0-9]{40}$`) {
		return errors.New("Node bundle manifest does not bind the executable bundle")
	}
	return nil
}

func verifyNodeInterpreter(entry *zip.File) error {
	invalid := errors.New("Node executable does not use the Android linker")
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	var header [64]byte
	if _, err = io.ReadFull(reader, header[:]); err != nil || binary.LittleEndian.Uint16(header[16:18]) != 3 {
		return invalid
	}
	offset := binary.LittleEndian.Uint64(header[32:40])
	count := binary.LittleEndian.Uint16(header[56:58])
	if _, err = io.CopyN(io.Discard, reader, int64(offset-64)); err != nil {
		return invalid
	}
	var interpreter uint64
	var program [56]byte
	for i := uint16(0); i < count; i++ {
		if _, err = io.ReadFull(reader, program[:]); err != nil {
			return invalid
		}
		if binary.LittleEndian.Uint32(program[:4]) != 3 {
			continue
		}
		start := binary.LittleEndian.Uint64(program[8:16])
		size := binary.LittleEndian.Uint64(program[32:40])
		if interpreter != 0 || start == 0 || size != uint64(len(androidInterpreter)) ||
			start > entry.UncompressedSize64 || size > entry.UncompressedSize64-start {
			return invalid
		}
		interpreter = start
	}
	if interpreter == 0 {
		return invalid
	}
	reopened, err := entry.Open()
	if err != nil {
		return err
	}
	defer reopened.Close()
	var link [len(androidInterpreter)]byte
	if _, err = io.CopyN(io.Discard, reopened, int64(interpreter)); err != nil {
		return invalid
	}
	if _, err = io.ReadFull(reopened, link[:]); err != nil || string(link[:]) != androidInterpreter {
		return invalid
	}
	return nil
}
