package otatrust

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type enrollmentConfig struct {
	Schema       int64    `json:"schemaVersion"`
	Repository   string   `json:"repository"`
	Distribution string   `json:"distribution"`
	Signer       string   `json:"signerSha256"`
	RootHash     string   `json:"rootSha256"`
	MetadataBase string   `json:"metadataBase"`
	Hosts        []string `json:"approvedHosts"`
}

// Enrollment contains only provisioned public trust material and a random cohort
// identifier. It is not installation authority or evidence of qualified time.
type Enrollment struct {
	Config   []byte `json:"config"`
	Root     []byte `json:"root"`
	CohortID string `json:"cohortId"`
}
type enrollmentEnvelope struct {
	Value Enrollment `json:"value"`
	Hash  string     `json:"sha256"`
}

func validateEnrollment(config, root []byte) error {
	if len(config) > 65536 {
		return errors.New("enrollment configuration too large")
	}
	var c enrollmentConfig
	if err := decodeAdmission(config, &c); err != nil {
		return err
	}
	if c.Schema != 1 || !matches(c.Repository, repositoryPattern) || !contains([]string{"launcher", "standalone"}, c.Distribution) || !validHex(c.Signer) || !validHex(c.RootHash) {
		return errors.New("invalid enrollment identity")
	}
	if !stringList(c.Hosts, 1, 16, func(host string) bool {
		return len(host) <= 253 && hostnamePattern.MatchString(host) && !strings.HasSuffix(host, ".local") && !strings.HasSuffix(host, ".internal") && !strings.HasSuffix(host, ".localhost")
	}) {
		return errors.New("invalid enrollment hosts")
	}
	u, err := url.Parse(c.MetadataBase)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || !contains(c.Hosts, u.Host) || !strings.HasSuffix(c.MetadataBase, "/") || strings.Contains(u.Path, "..") || strings.Contains(u.Path, "\\") {
		return errors.New("invalid enrollment metadata base")
	}
	if len(root) == 0 || len(root) > int(maxBytes) {
		return errors.New("invalid enrollment root size")
	}
	sum := sha256.Sum256(root)
	if hex.EncodeToString(sum[:]) != c.RootHash {
		return errors.New("enrollment root pin mismatch")
	}
	if err = checkJSON(root); err != nil {
		return err
	}
	parsed, err := metadata.Root().FromBytes(root)
	if err != nil {
		return err
	}
	if parsed.Signed.Version < 1 || !parsed.Signed.ConsistentSnapshot {
		return errors.New("unsupported enrollment root")
	}
	if err = parsed.VerifyDelegate("root", parsed); err != nil {
		return err
	}
	for _, name := range []string{"root", "timestamp", "snapshot", "targets"} {
		role := parsed.Signed.Roles[name]
		if role == nil || role.Threshold < 1 || role.Threshold > len(role.KeyIDs) {
			return errors.New("invalid enrollment role")
		}
		seen := map[string]bool{}
		for _, id := range role.KeyIDs {
			if seen[id] || parsed.Signed.Keys[id] == nil {
				return errors.New("invalid enrollment role key")
			}
			seen[id] = true
		}
	}
	// Expiry is enforced during TUF refresh with qualified time, never wall time
	// supplied implicitly by manufacturing, a renderer or this storage API.
	return nil
}

// InitializeEnrollment is a factory/staff-only native operation on a dedicated
// empty private directory. It has no renderer API, network enrollment, default
// root, or implicit repair. Interrupted enrollment must be handled before handoff.
func InitializeEnrollment(directory string, config, root []byte) error {
	return initializeEnrollment(directory, config, root, nil)
}
func initializeEnrollment(directory string, config, root []byte, fault func(string)) error {
	if err := validateEnrollment(config, root); err != nil {
		return err
	}
	return lockedEnrollment(directory, func() error {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name() != ".enrollment.lock" {
				return errors.New("enrollment directory is not empty")
			}
		}
		marker, e := os.OpenFile(filepath.Join(directory, "initialized"), os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
		if e != nil {
			return e
		}
		_, e = marker.Write([]byte{1})
		e = errors.Join(e, marker.Sync(), marker.Close())
		if e != nil {
			return e
		}
		parent, e := os.Open(directory)
		if e != nil {
			return e
		}
		e = errors.Join(parent.Sync(), parent.Close())
		if e != nil {
			return e
		}
		random := make([]byte, 32)
		if _, err = rand.Read(random); err != nil {
			return err
		}
		value := Enrollment{Config: append([]byte(nil), config...), Root: append([]byte(nil), root...), CohortID: hex.EncodeToString(random)}
		hash, err := admissionHash(value)
		if err != nil {
			return err
		}
		data, err := json.Marshal(enrollmentEnvelope{Value: value, Hash: hash})
		if err != nil {
			return err
		}
		if len(data) > 2*int(maxBytes) {
			return errors.New("enrollment exceeds storage budget")
		}
		// CREATE_NEW leaves a durable attempt marker even if the process dies while
		// writing. Normal reads and repeated initialization never reset it silently.
		temporary := filepath.Join(directory, "enrollment.next")
		file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
		if err != nil {
			return err
		}
		if _, err = file.Write(data); err != nil {
			file.Close()
			return err
		}
		if fault != nil {
			fault("before-sync")
		}
		err = errors.Join(file.Sync(), file.Close())
		if err != nil {
			return err
		}
		if fault != nil {
			fault("before-rename")
		}
		if err = os.Rename(temporary, filepath.Join(directory, "enrollment.json")); err != nil {
			return err
		}
		dir, err := os.Open(directory)
		if err != nil {
			return err
		}
		err = errors.Join(dir.Sync(), dir.Close())
		if err != nil {
			return err
		}
		if fault != nil {
			fault("published")
		}
		return nil
	})
}

// ReadEnrollment never enrolls or resets missing, corrupt or partial state.
func ReadEnrollment(directory string) (result *Enrollment, err error) {
	err = lockedEnrollment(directory, func() error {
		entries, e := os.ReadDir(directory)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if entry.Name() != ".enrollment.lock" && entry.Name() != "enrollment.json" && entry.Name() != "initialized" {
				return errors.New("partial or unexpected enrollment state")
			}
		}
		marker := filepath.Join(directory, "initialized")
		mi, e := os.Lstat(marker)
		if e != nil || !mi.Mode().IsRegular() || mi.Size() != 1 {
			return errors.New("enrollment marker missing or unsafe")
		}
		mb, e := os.ReadFile(marker)
		if e != nil || len(mb) != 1 || mb[0] != 1 {
			return errors.New("invalid enrollment marker")
		}
		file := filepath.Join(directory, "enrollment.json")
		info, e := os.Lstat(file)
		if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 2*maxBytes {
			return errors.New("enrollment missing or unsafe")
		}
		data, e := os.ReadFile(file)
		if e != nil {
			return e
		}
		var envelope enrollmentEnvelope
		// Enrollment embeds base64 bytes: use bounded strict JSON decoding directly,
		// as admission's smaller descriptor limit is not this envelope's limit.
		if e = checkJSON(data); e != nil {
			return e
		}
		if e = decodeEnrollmentEnvelope(data, &envelope); e != nil {
			return e
		}
		hash, e := admissionHash(envelope.Value)
		if e != nil || hash != envelope.Hash {
			return errors.New("enrollment checksum mismatch")
		}
		if !validHex(envelope.Value.CohortID) {
			return errors.New("invalid enrollment cohort")
		}
		if e = validateEnrollment(envelope.Value.Config, envelope.Value.Root); e != nil {
			return e
		}
		result = &envelope.Value
		return nil
	})
	return
}
func lockedEnrollment(directory string, operation func() error) error {
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("private enrollment directory unavailable")
	}
	f, err := os.OpenFile(filepath.Join(directory, ".enrollment.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("unsafe enrollment lock")
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("enrollment busy")
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return operation()
}

func decodeEnrollmentEnvelope(data []byte, out *enrollmentEnvelope) error {
	if !utf8.Valid(data) {
		return errors.New("invalid enrollment encoding")
	}
	if err := json.Unmarshal(data, out); err != nil {
		return err
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return err
	}
	var original, canonical any
	if err = json.Unmarshal(data, &original); err != nil {
		return err
	}
	if err = json.Unmarshal(encoded, &canonical); err != nil {
		return err
	}
	if !reflect.DeepEqual(original, canonical) {
		return errors.New("invalid enrollment envelope shape")
	}
	return nil
}
