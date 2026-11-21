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
	"os"
	"strings"
	"syscall"
	"unicode/utf8"
)

const (
	runtimeInventoryAsset = "assets/agent/inventory.json"
	nodeLibraryName       = "libeliza_node.so"
	agentBundleAsset      = "assets/agent/agent.mjs"
	bundleManifestAsset   = "assets/agent/manifest.json"
	gatewayAssets         = "assets/agent/gateway/"
	maxInventoryBytes     = 2 * 1024 * 1024
	maxInventoryRows      = 16384
	maxRuntimeFileBytes   = 512 * 1024 * 1024
	maxRuntimeTotalBytes  = 2 * 1024 * 1024 * 1024
)

var runtimeMachines = map[string]uint16{"arm64-v8a": 183, "x86_64": 62}

type runtimeInventoryRow struct {
	Path   *string `json:"path"`
	SHA256 *string `json:"sha256"`
	Size   *int64  `json:"size"`
}

type runtimeInventory struct {
	Schema *int64                `json:"schema"`
	Files  []runtimeInventoryRow `json:"files"`
}

func VerifyRuntimeArtifact(name string, artifactJSON []byte, approvedHosts, abi string) error {
	if _, err := requiredHostPolicy(); err != nil {
		return err
	}
	var artifact releaseArtifact
	if err := decodeAdmission(artifactJSON, &artifact); err != nil {
		return err
	}
	hosts := strings.Split(approvedHosts, ",")
	if !stringList(hosts, 1, 16, func(s string) bool { return hostnamePattern.MatchString(s) }) {
		return errors.New("invalid artifact hosts")
	}
	if err := validateNativeArtifact(artifact, hosts); err != nil {
		return err
	}
	if _, node := runtimeMachines[abi]; !node || !contains(artifact.Android.ABIs, abi) {
		return errors.New("unqualified runtime ABI")
	}
	file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() != artifact.Length {
		return errors.New("APK length or type mismatch")
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, artifact.Length+1))
	if err != nil || n != artifact.Length || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return errors.New("APK digest mismatch")
	}
	if err = boundedAPKDirectory(file, artifact.Length); err != nil {
		return err
	}
	archive, err := zip.NewReader(file, artifact.Length)
	if err != nil {
		return errors.New("invalid APK ZIP")
	}
	entries := map[string]*zip.File{}
	for _, entry := range archive.File {
		if !utf8.ValidString(entry.Name) || strings.Contains(entry.Name, "\\") || strings.HasPrefix(entry.Name, "/") || entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe APK entry")
		}
		for _, segment := range strings.Split(entry.Name, "/") {
			if segment == ".." || segment == "." {
				return errors.New("unsafe APK path")
			}
		}
		if _, exists := entries[entry.Name]; exists {
			return errors.New("duplicate APK entry")
		}
		entries[entry.Name] = entry
	}
	inventoryEntry := entries[runtimeInventoryAsset]
	if inventoryEntry == nil || inventoryEntry.UncompressedSize64 > maxInventoryBytes {
		return errors.New("runtime inventory missing or oversized")
	}
	data, err := readAPKEntry(inventoryEntry, maxInventoryBytes)
	if err != nil {
		return err
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != artifact.Runtime.Inventory {
		return errors.New("runtime inventory digest mismatch")
	}
	rows, err := parseRuntimeInventory(data)
	if err != nil {
		return err
	}
	listed := map[string]string{}
	trees := map[string]bool{}
	natives := map[string]string{}
	var total int64
	for _, row := range rows {
		path, digest, size := *row.Path, *row.SHA256, *row.Size
		if _, exists := listed[path]; exists {
			return errors.New("duplicate runtime inventory path")
		}
		if !validHex(digest) || size < 1 || size > maxRuntimeFileBytes {
			return errors.New("invalid runtime inventory row")
		}
		if total += size; total > maxRuntimeTotalBytes {
			return errors.New("runtime total too large")
		}
		entry := entries[path]
		if entry == nil || entry.UncompressedSize64 != uint64(size) {
			return errors.New("packaged runtime file missing or wrong length")
		}
		kind, rowABI := runtimeRowKind(path)
		switch kind {
		case "library":
			if !contains(artifact.Android.ABIs, rowABI) {
				return errors.New("native runtime for an untargeted ABI")
			}
			if forbiddenLoader(path) {
				return errors.New("runtime loader present")
			}
			if err = verifyRuntimeELF(entry, runtimeMachines[rowABI]); err != nil {
				return err
			}
			natives[path] = digest
		case "asset":
			if strings.HasPrefix(path, gatewayAssets) {
				return errors.New("gateway file present")
			}
			trees[strings.SplitN(path, "/", 3)[1]] = true
		default:
			return errors.New("invalid runtime inventory path")
		}
		if err = hashAPKEntry(entry, size, digest); err != nil {
			return err
		}
		listed[path] = digest
	}
	for name, entry := range entries {
		if _, ok := listed[name]; ok || entry.FileInfo().IsDir() || name == runtimeInventoryAsset {
			continue
		}
		parts := strings.SplitN(name, "/", 3)
		if parts[0] == "lib" || strings.HasPrefix(name, gatewayAssets) || (parts[0] == "assets" && len(parts) == 3 && trees[parts[1]]) {
			return errors.New("unlisted runtime file")
		}
	}
	for _, target := range artifact.Android.ABIs {
		if natives["lib/"+target+"/"+nodeLibraryName] == "" {
			return errors.New("node runtime absent for a targeted ABI")
		}
	}
	if len(natives) != len(artifact.Runtime.Libraries) {
		return errors.New("native inventory differs from the declaration")
	}
	for path, digest := range natives {
		if artifact.Runtime.Libraries[path] != digest {
			return errors.New("native declaration mismatch")
		}
	}
	if listed[agentBundleAsset] != artifact.Runtime.Agent || listed[bundleManifestAsset] == "" {
		return errors.New("agent bundle declaration mismatch")
	}
	return nil
}

func parseRuntimeInventory(data []byte) ([]runtimeInventoryRow, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("invalid runtime inventory encoding")
	}
	if err := checkJSON(data); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var inventory runtimeInventory
	if err := decoder.Decode(&inventory); err != nil {
		return nil, errors.New("invalid runtime inventory")
	}
	if inventory.Schema == nil || *inventory.Schema != 1 || len(inventory.Files) < 1 || len(inventory.Files) > maxInventoryRows {
		return nil, errors.New("invalid runtime inventory schema")
	}
	for _, row := range inventory.Files {
		if row.Path == nil || row.SHA256 == nil || row.Size == nil {
			return nil, errors.New("incomplete runtime inventory row")
		}
	}
	return inventory.Files, nil
}

func runtimeRowKind(path string) (string, string) {
	if !runtimePath(path) {
		return "", ""
	}
	parts := strings.Split(path, "/")
	if len(parts) == 3 && parts[0] == "lib" && matches(parts[2], `^lib[A-Za-z0-9_.+-]+\.so$`) {
		if _, node := runtimeMachines[parts[1]]; node {
			return "library", parts[1]
		}
	}
	if len(parts) >= 3 && parts[0] == "assets" && path != runtimeInventoryAsset {
		return "asset", ""
	}
	return "", ""
}

func forbiddenLoader(path string) bool {
	return matches(path[strings.LastIndex(path, "/")+1:], `^(libeliza_ld_[A-Za-z0-9_]+|libeliza_bun|ld-[A-Za-z0-9_.-]+)\.so$`)
}

func runtimePath(value string) bool {
	if value == "" || len(value) > 1024 || strings.HasPrefix(value, "/") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." || !matches(segment, `^[A-Za-z0-9_@.+-]+$`) {
			return false
		}
	}
	return true
}

func boundedAPKDirectory(file *os.File, length int64) error {
	tail := make([]byte, min(length, 65557))
	if _, err := file.ReadAt(tail, length-int64(len(tail))); err != nil {
		return err
	}
	for offset := len(tail) - 22; offset >= 0; offset-- {
		b := tail[offset:]
		if !bytes.HasPrefix(b, []byte{'P', 'K', 5, 6}) || offset+22+int(binary.LittleEndian.Uint16(b[20:22])) != len(tail) {
			continue
		}
		count := binary.LittleEndian.Uint16(b[10:12])
		size := binary.LittleEndian.Uint32(b[12:16])
		start := binary.LittleEndian.Uint32(b[16:20])
		if binary.LittleEndian.Uint16(b[4:6]) != 0 || binary.LittleEndian.Uint16(b[6:8]) != 0 || binary.LittleEndian.Uint16(b[8:10]) != count || count == 0 || count > 32768 || size > 16*1024*1024 || int64(start)+int64(size) != length-int64(len(tail))+int64(offset) {
			return errors.New("unsupported APK directory bounds")
		}
		central := make([]byte, int(size))
		if _, err := file.ReadAt(central, int64(start)); err != nil {
			return err
		}
		cursor, records := 0, 0
		for cursor < len(central) {
			if len(central)-cursor < 46 || !bytes.Equal(central[cursor:cursor+4], []byte{'P', 'K', 1, 2}) {
				return errors.New("invalid APK central record")
			}
			record := central[cursor:]
			cursor += 46 + int(binary.LittleEndian.Uint16(record[28:30])) + int(binary.LittleEndian.Uint16(record[30:32])) + int(binary.LittleEndian.Uint16(record[32:34]))
			records++
			if cursor > len(central) || records > int(count) {
				return errors.New("APK central record bounds")
			}
		}
		if records != int(count) {
			return errors.New("APK central record count")
		}
		return nil
	}
	return errors.New("APK directory absent")
}

func readAPKEntry(entry *zip.File, limit int64) ([]byte, error) {
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("invalid APK entry bytes")
	}
	return data, nil
}

func hashAPKEntry(entry *zip.File, length int64, expected string) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(reader, length+1))
	if err != nil || n != length || hex.EncodeToString(hash.Sum(nil)) != expected {
		return errors.New("packaged runtime digest mismatch")
	}
	return nil
}

func verifyRuntimeELF(entry *zip.File, machine uint16) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	var header [64]byte
	if _, err = io.ReadFull(reader, header[:]); err != nil {
		return errors.New("native runtime ELF header missing")
	}
	h := header[:]
	kind := binary.LittleEndian.Uint16(h[16:18])
	count := uint64(binary.LittleEndian.Uint16(h[56:58]))
	offset := binary.LittleEndian.Uint64(h[32:40])
	if !bytes.Equal(h[:4], []byte{0x7f, 'E', 'L', 'F'}) || h[4] != 2 || h[5] != 1 || h[6] != 1 || (kind != 2 && kind != 3) || binary.LittleEndian.Uint16(h[18:20]) != machine || binary.LittleEndian.Uint32(h[20:24]) != 1 || binary.LittleEndian.Uint16(h[52:54]) != 64 || binary.LittleEndian.Uint16(h[54:56]) != 56 || count == 0 || count > 4096 || offset < 64 || offset > entry.UncompressedSize64 || count*56 > entry.UncompressedSize64-offset {
		return errors.New("native runtime ELF ABI or bounds invalid")
	}
	return nil
}
