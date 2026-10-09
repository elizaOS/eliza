// Package otatrust authenticates bounded release descriptors with go-tuf. The
// Android host supplies restricted HTTPS transport and a qualified trusted time.
// It does not download APKs or make installation decisions.
package otatrust

import (
	"errors"
	"fmt"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxBytes int64 = 1024 * 1024

// Response and Transport use gomobile-compatible types. Transport must enforce
// TLS, host/DNS/redirect restrictions, deadlines and cancellation independently.
type Response struct {
	Status int
	Data   []byte
}
type Transport interface {
	Fetch(address string, limit int64) (*Response, error)
}
type boundedFetcher struct {
	directory string
	transport Transport
	prefix    string
	remaining int64
	requests  int
}

func (f *boundedFetcher) DownloadFile(address string, limit int64, _ time.Duration) ([]byte, error) {
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(address, f.prefix) || strings.Contains(u.Path, "..") || strings.Contains(u.Path, "\\") || u.RawPath != "" {
		return nil, errors.New("unapproved TUF URL")
	}
	if limit < 1 || limit > maxBytes || f.requests >= 128 || f.remaining < limit {
		return nil, errors.New("TUF fetch budget exceeded")
	}
	if f.directory != "" {
		if err := syncCache(f.directory); err != nil {
			return nil, err
		}
	}
	f.requests++
	f.remaining -= limit
	response, err := f.transport.Fetch(address, limit)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, errors.New("missing transport response")
	}
	if response.Status != 200 {
		return nil, &metadata.ErrDownloadHTTP{StatusCode: response.Status, URL: address}
	}
	if int64(len(response.Data)) > limit {
		return nil, errors.New("TUF response exceeds limit")
	}
	if err := checkJSON(response.Data); err != nil {
		return nil, err
	}
	return response.Data, nil
}

var sessionLock sync.Mutex

// FetchDescriptorInterval performs the TUF client workflow and returns only hash- and
// length-verified target bytes. privateDirectory must be exclusively owned by
// the supervisor. Both process and filesystem locks serialize cache mutation.
// metadataBase is provisioned, never selected by downloaded metadata.
// It uses the upper authenticated bound for TUF reference
// time and persists only the lower bound. Bounds describe the start of this TUF
// workflow; callers must refresh time and authorization before activation.
// This API does not establish time trust or configure the transport's TLS clock.
func FetchDescriptorInterval(privateDirectory string, pinnedRoot []byte, metadataBase, channel, distribution string, trustedLowerMillis, trustedUpperMillis int64, transport Transport) (result []byte, err error) {
	if !sessionLock.TryLock() {
		return nil, errors.New("trust session already active")
	}
	defer sessionLock.Unlock()
	if (channel != "stable" && channel != "beta") || (distribution != "launcher" && distribution != "standalone") || !bounded(trustedLowerMillis, 1, safeInteger) || !bounded(trustedUpperMillis, trustedLowerMillis, safeInteger) || transport == nil || len(pinnedRoot) == 0 || int64(len(pinnedRoot)) > maxBytes {
		return nil, errors.New("invalid provisioned trust inputs")
	}
	base, e := url.Parse(metadataBase)
	if e != nil || base.Scheme != "https" || base.Hostname() == "" || base.Port() != "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.RawPath != "" || !strings.HasSuffix(metadataBase, "/") {
		return nil, errors.New("invalid metadata base")
	}
	stat, e := os.Lstat(privateDirectory)
	if e != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 || stat.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private trust directory unavailable")
	}
	lock, e := os.OpenFile(filepath.Join(privateDirectory, ".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, errors.New("trust cache already in use")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	// Refuse unsafe cached entries before the library reads any of them.
	if e = syncCache(privateDirectory); e != nil {
		return nil, e
	}
	clockBytes, clockErr := os.ReadFile(filepath.Join(privateDirectory, ".clock"))
	if clockErr == nil {
		floor, parseErr := strconv.ParseInt(string(clockBytes), 10, 64)
		if parseErr != nil || !bounded(floor, 1, safeInteger) || trustedUpperMillis < floor {
			return nil, errors.New("trusted time rollback or corruption")
		}
		trustedLowerMillis = max(trustedLowerMillis, floor)
	} else if !os.IsNotExist(clockErr) {
		return nil, clockErr
	}
	root := pinnedRoot
	cached, e := os.ReadFile(filepath.Join(privateDirectory, "root.json"))
	if e == nil {
		if os.IsNotExist(clockErr) {
			return nil, errors.New("trusted time floor missing")
		}
		root = cached
	} else if !os.IsNotExist(e) {
		return nil, e
	} else {
		entries, _ := os.ReadDir(privateDirectory)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				return nil, errors.New("trusted root missing from existing cache")
			}
		}
	}
	if e = checkJSON(root); e != nil {
		return nil, e
	}
	cfg, e := config.New(metadataBase, root)
	if e != nil {
		return nil, e
	}
	cfg.LocalMetadataDir = privateDirectory
	cfg.LocalTargetsDir = privateDirectory
	cfg.RootMaxLength = maxBytes
	cfg.TimestampMaxLength = 16384
	cfg.SnapshotMaxLength = maxBytes
	cfg.TargetsMaxLength = maxBytes
	cfg.MaxRootRotations = 32
	cfg.MaxDelegations = 16
	cfg.Fetcher = &boundedFetcher{transport: transport, prefix: metadataBase, remaining: 64 * maxBytes, directory: privateDirectory}
	if e = persistClock(privateDirectory, trustedLowerMillis); e != nil {
		return nil, e
	}
	client, e := updater.New(cfg)
	if e != nil {
		return nil, e
	}
	// This API name emphasizes that the caller is responsible for time trust.
	// A missing/unqualified clock must never reach this entry point.
	// go-tuf 2.4.2 uses reference.After(expiry), accepting equality. Move
	// one nanosecond beyond the inclusive upper bound to enforce expiry <=
	// upper as expired, without changing the lower bound saved to disk.
	client.UnsafeSetRefTime(time.UnixMilli(trustedUpperMillis).Add(time.Nanosecond))
	// go-tuf atomically renames metadata but does not fsync it. Sync every file
	// and the directory before returning even on refresh failure/root rotation.
	defer func() {
		if syncErr := syncCache(privateDirectory); syncErr != nil {
			result = nil
			err = errors.Join(err, syncErr)
		}
	}()
	if e = client.Refresh(); e != nil {
		return nil, e
	}
	trusted := client.GetTrustedMetadataSet()
	if e = validateChannelRoles(trusted.Root, trusted.Targets[metadata.TARGETS]); e != nil {
		return nil, e
	}
	info, e := client.GetTargetInfo(channel + "/" + distribution + ".json")
	if e != nil {
		return nil, e
	}
	trusted = client.GetTrustedMetadataSet()
	if e = validateChannelTargets(channel, trusted.Targets[channel]); e != nil {
		return nil, e
	}
	if info.Length < 1 || info.Length > maxBytes {
		return nil, errors.New("descriptor length out of bounds")
	}
	_, data, e := client.DownloadTarget(info, filepath.Join(privateDirectory, "descriptor.json"), metadataBase+"targets/")
	if e != nil {
		return nil, e
	}
	return data, nil
}
func syncCache(directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) > 256 {
		return errors.New("TUF cache entry budget exceeded")
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maxBytes {
			return errors.New("unsafe TUF cache entry")
		}
		if strings.HasSuffix(entry.Name(), ".json") {
			data, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
			if readErr != nil {
				return readErr
			}
			if parseErr := checkJSON(data); parseErr != nil {
				return parseErr
			}
		}
		file, err := os.Open(filepath.Join(directory, entry.Name()))
		if err != nil {
			return err
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		if syncErr != nil || closeErr != nil {
			return fmt.Errorf("TUF cache sync: %w", errors.Join(syncErr, closeErr))
		}
	}
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

func persistClock(directory string, millis int64) error {
	file, err := os.CreateTemp(directory, "clock_tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.WriteString(strconv.FormatInt(millis, 10)); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(directory, ".clock")); err != nil {
		return err
	}
	return syncCache(directory)
}
