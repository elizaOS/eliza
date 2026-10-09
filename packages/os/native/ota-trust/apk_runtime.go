package otatrust

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

// runtimeInventoryAsset is the APK entry written by plugin-native-agent's
// stageAndroidRuntimeInventory (ANDROID_RUNTIME_INVENTORY_ASSET) and read by
// RuntimeBundleStore. Its first line must equal the host policy's
// runtimeInventoryHeader, which the host also passes to the packager and store.
const runtimeInventoryAsset = "assets/agent-runtime.inventory"

// VerifyRuntimeArtifact verifies complete APK identity and packaged runtime
// bytes against authenticated artifact metadata. Android must independently
// verify package/version/distribution/signing and commit-time eligibility.
// This profile accepts single ZIP32 APKs, at most 1 GiB and 32768 entries.
func VerifyRuntimeArtifact(name string, artifactJSON []byte, approvedHosts, abi string) error {
	host, hostErr := requiredHostPolicy()
	if hostErr != nil {
		return hostErr
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
	if !contains(artifact.Android.ABIs, abi) || abi != "arm64-v8a" {
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
	inventory := entries[runtimeInventoryAsset]
	if inventory == nil || inventory.UncompressedSize64 > 2*1024*1024 {
		return errors.New("runtime inventory missing or oversized")
	}
	data, err := readAPKEntry(inventory, 2*1024*1024)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != artifact.Runtime.Inventory {
		return errors.New("runtime inventory digest mismatch")
	}
	if !utf8.Valid(data) || !bytes.HasSuffix(data, []byte("\n")) {
		return errors.New("invalid runtime inventory encoding")
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) < 3 || len(lines) > 16386 || lines[0] != host.RuntimeInventoryHeader {
		return errors.New("invalid runtime inventory header")
	}
	sources := map[string]bool{}
	destinations := map[string]string{}
	native := map[string]string{}
	var total int64
	for _, line := range lines[1 : len(lines)-1] {
		fields := strings.Split(line, "\t")
		if len(fields) != 5 || !matches(fields[1], `^(0|[1-9][0-9]{0,9})$`) || !validHex(fields[2]) {
			return errors.New("invalid runtime inventory row")
		}
		size, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || size > 512*1024*1024 {
			return errors.New("runtime entry too large")
		}
		total += size
		if total > 2*1024*1024*1024 {
			return errors.New("runtime total too large")
		}
		source, destination := fields[3], fields[4]
		entryName := ""
		switch fields[0] {
		case "asset":
			if size == 0 && contains([]string{"bundle/agent-bundle.js", "bundle/gateway/local-agent-gateway.mjs", "bundle/gateway/task-runtime.mjs", "bundle/gateway/bootstrap.mjs"}, destination) {
				return errors.New("required runtime code is empty")
			}
			if !runtimePath(source) || !runtimePath(destination) || !(strings.HasPrefix(source, "agent/") || matches(source, `^runtime-blobs/[a-f0-9]{64}\.bin$`)) || !(strings.HasPrefix(destination, "bundle/") || matches(destination, `^[A-Za-z0-9_.+-]+\.tar\.gz$`)) {
				return errors.New("invalid runtime asset path")
			}
			if _, exists := destinations[destination]; exists {
				return errors.New("duplicate runtime destination")
			}
			destinations[destination] = fields[2]
			entryName = "assets/" + source
		case "native":
			if !matches(source, `^lib[A-Za-z0-9_.-]+\.so$`) || destination != "-" {
				return errors.New("invalid native inventory path")
			}
			if _, exists := native[source]; exists {
				return errors.New("duplicate native runtime")
			}
			native[source] = fields[2]
			if artifact.Runtime.Libraries[source] != fields[2] {
				return errors.New("native declaration mismatch")
			}
			entryName = "lib/" + abi + "/" + source
		default:
			return errors.New("unknown runtime inventory kind")
		}
		// Repeated digest-addressed blobs are rehashed within the total byte budget.
		entry := entries[entryName]
		if entry == nil || entry.UncompressedSize64 != uint64(size) {
			return errors.New("packaged runtime file missing or wrong length")
		}
		sources[entryName] = true
		if fields[0] == "native" {
			if err = verifyARM64RuntimeELF(entry); err != nil {
				return err
			}
		}
		if err = hashAPKEntry(entry, size, fields[2]); err != nil {
			return err
		}
	}
	for name, entry := range entries {
		if entry.FileInfo().IsDir() || sources[name] {
			continue
		}
		agentPath, agent := strings.CutPrefix(name, "assets/agent/")
		if strings.HasPrefix(name, "assets/runtime-blobs/") || agent && !excludedAgentAsset(agentPath, host.RuntimeExcludedAgentDirectories) && !readdressedArchive(agentPath, destinations) {
			return errors.New("unlisted runtime asset")
		}
	}
	for _, required := range []string{"libeliza_bun.so", "libeliza_ld_musl_aarch64.so"} {
		if native[required] == "" {
			return errors.New("required native agent library absent")
		}
	}
	if len(native) != len(artifact.Runtime.Libraries) {
		return errors.New("native inventory incomplete")
	}
	for path, digest := range map[string]string{"bundle/agent-bundle.js": artifact.Runtime.Agent, "bundle/gateway/local-agent-gateway.mjs": artifact.Runtime.Gateway, "bundle/gateway/task-runtime.mjs": artifact.Runtime.Policy} {
		if destinations[path] != digest {
			return errors.New("agent/gateway/policy declaration mismatch")
		}
	}
	if destinations["bundle/gateway/bootstrap.mjs"] == "" {
		return errors.New("gateway bootstrap missing")
	}
	return nil
}

// excludedAgentAsset mirrors the packager's exact-directory exclusions.
func excludedAgentAsset(name string, directories []string) bool {
	for _, directory := range directories {
		if strings.HasPrefix(name, directory+"/") {
			return true
		}
	}
	return false
}

// readdressedArchive reports whether an agent archive was packaged as a listed
// content-addressed blob. RuntimeBundleStore never extracts the original path.
func readdressedArchive(name string, destinations map[string]string) bool {
	base := path.Base(name)
	if strings.HasSuffix(base, ".tar") {
		base += ".gz"
	}
	return strings.HasSuffix(base, ".tar.gz") && destinations[base] != ""
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

func verifyARM64RuntimeELF(entry *zip.File) error {
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
	if !bytes.Equal(h[:4], []byte{0x7f, 'E', 'L', 'F'}) || h[4] != 2 || h[5] != 1 || h[6] != 1 || (kind != 2 && kind != 3) || binary.LittleEndian.Uint16(h[18:20]) != 183 || binary.LittleEndian.Uint32(h[20:24]) != 1 || binary.LittleEndian.Uint16(h[52:54]) != 64 || binary.LittleEndian.Uint16(h[54:56]) != 56 || count == 0 || count > 4096 || offset < 64 || offset > entry.UncompressedSize64 || count*56 > entry.UncompressedSize64-offset {
		return errors.New("native runtime ELF ABI or bounds invalid")
	}
	return nil
}
