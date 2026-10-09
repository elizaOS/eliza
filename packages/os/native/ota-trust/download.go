package otatrust

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const maxArtifactBytes int64 = 1024 * 1024 * 1024

var errArtifactIntegrity = errors.New("artifact integrity mismatch")

// ArtifactDownloader has a 30-minute transfer budget and a 45-second body-idle
// timeout. Construct a fresh instance per attempt and Close on job cancellation.
// Metadata discovery continues to use its separate two-minute transport budget.
type ArtifactDownloader struct{ transport *HTTPTransport }

// NewArtifactDownloaderWithTimeSource uses the same interval-aware TLS boundary
// as metadata requests. Signed artifact identity and hash checks remain required.
func NewArtifactDownloaderWithTimeSource(approvedHosts string, source TrustedTimeSource) (*ArtifactDownloader, error) {
	t, err := NewHTTPTransportWithTimeSource(approvedHosts, source)
	if err != nil {
		return nil, err
	}
	return artifactDownloaderWithTransport(t), nil
}

func artifactDownloaderWithTransport(t *HTTPTransport) *ArtifactDownloader {
	t.cancel()
	t.ctx, t.cancel = context.WithTimeout(context.Background(), 30*time.Minute)
	t.client.Timeout = 0 // Headers/dial/TLS and body idle retain separate limits.
	return &ArtifactDownloader{transport: t}
}
func (d *ArtifactDownloader) Close() {
	if d != nil {
		d.transport.Close()
	}
}
func (d *ArtifactDownloader) RetryAfterMillis() int64 {
	if d == nil {
		return 0
	}
	return d.transport.RetryAfterMillis()
}
func (d *ArtifactDownloader) Download(directory, address, digest string, length, reserveBytes int64) (string, error) {
	if d == nil || d.transport == nil {
		return "", errors.New("artifact downloader unavailable")
	}
	return d.transport.DownloadArtifact(directory, address, digest, length, reserveBytes)
}

type artifactResume struct {
	URLHash string
	ETag    string
	Length  int64
}

// DownloadArtifact accepts length/hash/URL only from authenticated native
// admission. It returns a digest-addressed file after complete verification.
// Use one private staging directory for all artifacts to serialize downloads.
// reserveBytes is the measured free-space reserve that must remain after this
// transfer; it does not replace the full candidate/recovery installation budget.
// Close cancels I/O. A new transport resumes from the ORIGINAL URL, never a
// persisted temporary CDN redirect. No result grants installation authority.
func (t *HTTPTransport) DownloadArtifact(directory, address, digest string, length, reserveBytes int64) (string, error) {
	return t.downloadArtifact(directory, address, digest, length, reserveBytes, artifactFreeSpace)
}
func artifactFreeSpace(directory string) (int64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(directory, &stat); err != nil {
		return 0, err
	}
	if stat.Bsize <= 0 || uint64(stat.Bavail) > uint64(1<<63-1)/uint64(stat.Bsize) {
		return 0, errors.New("invalid storage capacity")
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}
func (t *HTTPTransport) downloadArtifact(directory, address, digest string, length, reserve int64, space func(string) (int64, error)) (result string, err error) {
	if t == nil || t.ctx == nil || t.client == nil {
		return "", errors.New("transport not initialized")
	}
	if !validHex(digest) || length < 1 || length > maxArtifactBytes || reserve < 0 || reserve > 1<<53 || len(address) > 2048 {
		return "", errors.New("invalid authenticated artifact inputs")
	}
	u, e := url.Parse(address)
	if e != nil || t.checkURL(u) != nil || u.RawQuery != "" {
		return "", errors.New("unapproved original artifact URL")
	}
	stat, e := os.Lstat(directory)
	if e != nil || !stat.IsDir() || stat.Mode().Perm()&0077 != 0 || stat.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("private artifact directory unavailable")
	}
	select {
	case <-t.ctx.Done():
		return "", errors.New("transport closed")
	default:
	}
	select {
	case t.active <- struct{}{}:
		defer func() { <-t.active }()
	default:
		return "", errors.New("request already active")
	}
	lock, e := os.OpenFile(filepath.Join(directory, ".download.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return "", e
	}
	defer lock.Close()
	if st, e := lock.Stat(); e != nil || !st.Mode().IsRegular() {
		return "", errors.New("unsafe artifact lock")
	}
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return "", errors.New("artifact download busy")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	final := filepath.Join(directory, digest+".apk")
	part := filepath.Join(directory, digest+".part")
	info := filepath.Join(directory, digest+".resume")
	for _, name := range []string{final, part, info} {
		st, e := os.Lstat(name)
		if e == nil && !st.Mode().IsRegular() {
			return "", errors.New("unsafe artifact cache entry")
		}
		if e != nil && !os.IsNotExist(e) {
			return "", e
		}
	}
	if _, e = os.Stat(final); e == nil {
		if e = verifyArtifact(final, digest, length); e == nil {
			if t.ctx.Err() != nil {
				return "", errors.New("artifact transfer cancelled")
			}
			return final, nil
		} else if !errors.Is(e, errArtifactIntegrity) {
			return "", e
		}
		// Repair only this digest-addressed cache entry after proven corruption.
		if e = os.Remove(final); e != nil {
			return "", e
		}
	}
	file, e := os.OpenFile(part, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return "", e
	}
	defer func() {
		err = errors.Join(err, file.Sync(), file.Close())
		if err != nil {
			result = ""
		}
	}()
	st, e := file.Stat()
	if e != nil {
		return "", e
	}
	offset := st.Size()
	reset := func() error {
		if e := file.Truncate(0); e != nil {
			return e
		}
		_, e := file.Seek(0, 0)
		offset = 0
		return e
	}
	urlDigest := sha256.Sum256([]byte(address))
	identity := hex.EncodeToString(urlDigest[:])
	resume := readArtifactResume(info)
	if offset > length || resume == nil || resume.URLHash != identity || resume.Length != length || !strongETag(resume.ETag) {
		if e = reset(); e != nil {
			return "", e
		}
		resume = nil
	}
	if offset == length {
		if e = verifyArtifact(part, digest, length); e != nil {
			return "", errors.Join(e, reset())
		}
		if e = file.Sync(); e != nil {
			return "", e
		}
		if t.ctx.Err() != nil {
			return "", errors.New("artifact transfer cancelled")
		}
		return publishArtifact(part, final, directory)
	}
	free, e := space(directory)
	if e != nil || free < length-offset+reserve {
		return "", errors.New("artifact storage reserve unavailable")
	}
	if t.RetryAfterMillis() > 0 {
		return "", errors.New("server retry delay active")
	}
	request, e := http.NewRequestWithContext(t.ctx, http.MethodGet, address, nil)
	if e != nil {
		return "", errors.New("invalid artifact request")
	}
	request.Header.Set("Accept-Encoding", "identity")
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		request.Header.Set("If-Range", resume.ETag)
	}
	response, e := t.client.Do(request)
	if e != nil {
		return "", errors.New("artifact HTTPS request failed")
	}
	defer response.Body.Close()
	idle := time.AfterFunc(t.artifactIdleTimeout, t.cancel)
	defer idle.Stop()
	if response.StatusCode == 429 || response.StatusCode == 503 {
		t.mu.Lock()
		t.retryAt = time.Now().Add(retryDelay(response.Header.Get("Retry-After"), time.Now()))
		t.mu.Unlock()
	}
	if response.StatusCode == 416 {
		if e = reset(); e != nil {
			return "", e
		}
		return "", errors.New("artifact range must restart")
	}
	if response.StatusCode != 200 && response.StatusCode != 206 {
		return "", errors.New("artifact HTTP status rejected")
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return "", errors.New("compressed artifact rejected")
	}
	if response.StatusCode == 206 {
		expected := fmt.Sprintf("bytes %d-%d/%d", offset, length-1, length)
		if offset == 0 || response.Header.Get("Content-Range") != expected || response.Header.Get("ETag") != resume.ETag {
			if e = reset(); e != nil {
				return "", e
			}
			return "", errors.New("artifact range identity mismatch")
		}
	} else {
		if response.Header.Get("Content-Range") != "" {
			return "", errors.New("unexpected artifact range")
		}
		if e = reset(); e != nil {
			return "", e
		}
	}
	if response.ContentLength >= 0 && response.ContentLength != length-offset {
		return "", errors.New("artifact response length mismatch")
	}
	if e = writeArtifactResume(info, artifactResume{URLHash: identity, ETag: response.Header.Get("ETag"), Length: length}); e != nil {
		return "", e
	}
	if _, e = file.Seek(offset, 0); e != nil {
		return "", e
	}
	buffer := make([]byte, 64*1024)
	for offset < length {
		if e = t.ctx.Err(); e != nil {
			return "", errors.New("artifact transfer cancelled")
		}
		free, e = space(directory)
		if e != nil || free < reserve+min(int64(len(buffer)), length-offset) {
			return "", errors.New("artifact storage reserve depleted")
		}
		n, readErr := response.Body.Read(buffer[:min(int64(len(buffer)), length-offset)])
		if n > 0 {
			idle.Reset(t.artifactIdleTimeout)
			written, writeErr := file.Write(buffer[:n])
			offset += int64(written)
			if writeErr != nil {
				return "", writeErr
			}
			if written != n {
				return "", io.ErrShortWrite
			}
		}
		if readErr != nil {
			if readErr == io.EOF && offset == length {
				break
			}
			return "", errors.New("artifact transfer interrupted")
		}
	}
	var extra [1]byte
	if n, e := io.ReadFull(response.Body, extra[:]); n != 0 || e != io.EOF {
		return "", errors.Join(errors.New("artifact exceeds authenticated length"), reset())
	}
	idle.Stop() // Network progress is complete; local hashing is not a body stall.
	if e = file.Sync(); e != nil {
		return "", e
	}
	if e = verifyArtifact(part, digest, length); e != nil {
		return "", errors.Join(e, reset())
	}
	if t.ctx.Err() != nil {
		return "", errors.New("artifact transfer cancelled")
	}
	return publishArtifact(part, final, directory)
}
func verifyArtifact(name, digest string, length int64) error {
	file, e := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return e
	}
	defer file.Close()
	stat, e := file.Stat()
	if e != nil {
		return e
	}
	if !stat.Mode().IsRegular() || stat.Size() != length {
		return errArtifactIntegrity
	}
	hash := sha256.New()
	n, e := io.Copy(hash, io.LimitReader(file, length+1))
	if e != nil {
		return e
	}
	if n != length || hex.EncodeToString(hash.Sum(nil)) != digest {
		return errArtifactIntegrity
	}
	return nil
}
func publishArtifact(part, final, directory string, faults ...func(string)) (string, error) {
	point := func(name string) {
		if len(faults) > 0 {
			faults[0](name)
		}
	}
	point("before-rename")
	if e := os.Rename(part, final); e != nil {
		return "", e
	}
	point("renamed")
	dir, e := os.Open(directory)
	if e != nil {
		return "", e
	}
	e = errors.Join(dir.Sync(), dir.Close())
	if e != nil {
		return "", e
	}
	point("published")
	return final, nil
}
func strongETag(value string) bool {
	if len(value) < 2 || len(value) > 256 || value[0] != '"' || value[len(value)-1] != '"' {
		return false
	}
	for _, c := range []byte(value[1 : len(value)-1]) {
		if c < 0x21 || c == 0x22 || c > 0x7e {
			return false
		}
	}
	return true
}
func readArtifactResume(name string) *artifactResume {
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Size() > 4096 {
		return nil
	}
	data, e := os.ReadFile(name)
	if e != nil || checkJSON(data) != nil {
		return nil
	}
	var state artifactResume
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil {
		return nil
	}
	return &state
}
func writeArtifactResume(name string, state artifactResume) error {
	// Untrusted ETags are bounded before persistence. Missing/weak validators force
	// a fresh transfer on the next attempt; full downloads still verify the hash.
	if !strongETag(state.ETag) {
		state.ETag = ""
	}
	data, e := json.Marshal(state)
	if e != nil {
		return e
	}
	dir := filepath.Dir(name)
	entries, e := os.ReadDir(dir)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "artifact_tmp") {
			st, e := entry.Info()
			if e != nil || !st.Mode().IsRegular() {
				return errors.New("unsafe artifact temporary file")
			}
			if e = os.Remove(filepath.Join(dir, entry.Name())); e != nil {
				return e
			}
		}
	}
	file, e := os.CreateTemp(dir, "artifact_tmp")
	if e != nil {
		return e
	}
	defer os.Remove(file.Name())
	_, e = file.Write(data)
	e = errors.Join(e, file.Sync(), file.Close())
	if e != nil {
		return e
	}
	if e = os.Rename(file.Name(), name); e != nil {
		return e
	}
	directory, e := os.Open(dir)
	if e != nil {
		return e
	}
	return errors.Join(directory.Sync(), directory.Close())
}
