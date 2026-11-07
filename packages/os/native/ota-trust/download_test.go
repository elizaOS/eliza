package otatrust

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func artifactFixture(t *testing.T) (string, []byte, string) {
	t.Helper()
	dir := t.TempDir()
	if e := os.Chmod(dir, 0700); e != nil {
		t.Fatal(e)
	}
	body := []byte(strings.Repeat("packaged-agent-apk", 8192))
	hash := sha256.Sum256(body)
	return dir, body, hex.EncodeToString(hash[:])
}
func seedArtifact(t *testing.T, dir, address, digest string, body []byte, tag string, offset int) {
	t.Helper()
	h := sha256.Sum256([]byte(address))
	if e := writeArtifactResume(filepath.Join(dir, digest+".resume"), artifactResume{URLHash: hex.EncodeToString(h[:]), ETag: tag, Length: int64(len(body))}); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, digest+".part"), body[:offset], 0600); e != nil {
		t.Fatal(e)
	}
}
func TestArtifactDownloadAndCachedRehash(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	var requests atomic.Int32
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("ETag", `"one"`)
		w.Write(body)
	})
	result, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 1024)
	if err != nil || result != filepath.Join(dir, digest+".apk") {
		t.Fatalf("%s %v", result, err)
	}
	cached, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 1024)
	if err != nil || cached != result || requests.Load() != 1 {
		t.Fatal("verified cache not reused")
	}
	if e := os.WriteFile(result, []byte("corrupt"), 0600); e != nil {
		t.Fatal(e)
	}
	if result, err = transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 1024); err != nil || result == "" || requests.Load() != 2 {
		t.Fatal("corrupt cache not repaired", err)
	}
	if err = verifyArtifact(result, digest, int64(len(body))); err != nil {
		t.Fatal(err)
	}
}
func TestArtifactResumeThroughRedirect(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	address := "https://example.com/original.apk"
	offset := 32123
	seedArtifact(t, dir, address, digest, body, `"one"`, offset)
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != fmt.Sprintf("bytes=%d-", offset) || r.Header.Get("If-Range") != `"one"` || r.Header.Get("Authorization") != "" {
			t.Error("resume headers lost or unsafe")
		}
		if r.URL.Path == "/original.apk" {
			http.Redirect(w, r, "https://example.com/cdn.apk?temporary=secret", 302)
			return
		}
		w.Header().Set("ETag", `"one"`)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, len(body)-1, len(body)))
		w.WriteHeader(206)
		w.Write(body[offset:])
	})
	result, err := transport.DownloadArtifact(dir, address, digest, int64(len(body)), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(result, digest, int64(len(body))); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, digest+".resume"))
	if strings.Contains(string(data), "secret") {
		t.Fatal("temporary redirect persisted")
	}
}
func TestArtifactResumeRestartsOnFullResponse(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	address := "https://example.com/app.apk"
	seedArtifact(t, dir, address, digest, body, `"old"`, 200)
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { w.Header().Set("ETag", `"new"`); w.Write(body) })
	result, err := transport.DownloadArtifact(dir, address, digest, int64(len(body)), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(result, digest, int64(len(body))); err != nil {
		t.Fatal(err)
	}
}
func TestArtifactBadResponsesNeverPublish(t *testing.T) {
	for _, scenario := range []string{"range", "etag", "unsolicited-range", "short", "long", "hash", "compressed", "length", "status", "unsatisfiable"} {
		t.Run(scenario, func(t *testing.T) {
			dir, body, digest := artifactFixture(t)
			address := "https://example.com/app.apk"
			if scenario == "range" || scenario == "etag" || scenario == "unsatisfiable" {
				seedArtifact(t, dir, address, digest, body, `"one"`, 100)
			}
			transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("ETag", `"one"`)
				switch scenario {
				case "range":
					w.Header().Set("Content-Range", "bytes 0-9/10")
					w.WriteHeader(206)
				case "etag":
					w.Header().Set("ETag", `"changed"`)
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 100-%d/%d", len(body)-1, len(body)))
					w.WriteHeader(206)
				case "unsolicited-range":
					w.WriteHeader(206)
				case "short":
					w.Header().Set("Content-Length", fmt.Sprint(len(body)))
					w.Write(body[:100])
					return
				case "long":
					w.(http.Flusher).Flush()
					w.Write(body)
					w.Write([]byte("extra"))
					return
				case "hash":
					w.Write([]byte(strings.Repeat("x", len(body))))
					return
				case "compressed":
					w.Header().Set("Content-Encoding", "gzip")
				case "length":
					w.Header().Set("Content-Length", fmt.Sprint(len(body)+1))
				case "status":
					w.WriteHeader(403)
				case "unsatisfiable":
					w.WriteHeader(416)
				}
				w.Write(body)
			})
			result, err := transport.DownloadArtifact(dir, address, digest, int64(len(body)), 0)
			if err == nil || result != "" {
				t.Fatal("unsafe response accepted")
			}
			if _, err = os.Stat(filepath.Join(dir, digest+".apk")); !os.IsNotExist(err) {
				t.Fatal("published bad artifact")
			}
		})
	}
}
func TestArtifactInterruptedBodyResumesOnNewTransport(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	address := "https://example.com/app.apk"
	offset := 4096
	first, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		w.Header().Set("ETag", `"one"`)
		w.Write(body[:offset])
	})
	if _, err := first.DownloadArtifact(dir, address, digest, int64(len(body)), 0); err == nil {
		t.Fatal("partial accepted")
	}
	first.Close()
	info, err := os.Stat(filepath.Join(dir, digest+".part"))
	if err != nil || info.Size() != int64(offset) {
		t.Fatal("partial progress lost")
	}
	second, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != fmt.Sprintf("bytes=%d-", offset) {
			t.Error("not resumed")
		}
		w.Header().Set("ETag", `"one"`)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, len(body)-1, len(body)))
		w.WriteHeader(206)
		w.Write(body[offset:])
	})
	if _, err = second.DownloadArtifact(dir, address, digest, int64(len(body)), 0); err != nil {
		t.Fatal(err)
	}
}
func TestArtifactWeakOrChangedSourceRestarts(t *testing.T) {
	for _, tag := range []string{"", `W/"weak"`, `"valid"`} {
		t.Run(tag, func(t *testing.T) {
			dir, body, digest := artifactFixture(t)
			seedURL := "https://example.com/new.apk"
			if tag == `"valid"` {
				seedURL = "https://example.com/old.apk"
			}
			seedArtifact(t, dir, seedURL, digest, body, tag, 512)
			transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Range") != "" {
					t.Error("unsafe resume")
				}
				w.Write(body)
			})
			if _, err := transport.DownloadArtifact(dir, "https://example.com/new.apk", digest, int64(len(body)), 0); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestArtifactStorageAndUnsafeCache(t *testing.T) {
	for _, scenario := range []string{"low", "depleted", "symlink"} {
		t.Run(scenario, func(t *testing.T) {
			dir, body, digest := artifactFixture(t)
			transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { w.Write(body) })
			if scenario == "symlink" {
				if e := os.Symlink(filepath.Join(dir, "other"), filepath.Join(dir, digest+".part")); e != nil {
					t.Fatal(e)
				}
			}
			calls := 0
			space := func(string) (int64, error) {
				calls++
				if scenario == "low" || scenario == "depleted" && calls > 2 {
					return 0, nil
				}
				return 1 << 40, nil
			}
			if result, err := transport.downloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 1024, space); err == nil || result != "" {
				t.Fatal("unsafe cache/storage accepted")
			}
			if _, err := os.Stat(filepath.Join(dir, digest+".apk")); !os.IsNotExist(err) {
				t.Fatal("artifact published")
			}
		})
	}
}
func TestArtifactCancellationAndConcurrentRefusal(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	entered := make(chan struct{})
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() })
	done := make(chan error, 1)
	go func() {
		_, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0)
		done <- err
	}()
	<-entered
	if _, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0); err == nil {
		t.Fatal("concurrent download accepted")
	}
	other, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { t.Error("competing downloader reached network") })
	if _, err := other.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0); err == nil {
		t.Fatal("independent downloader bypassed file lock")
	}
	transport.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not interrupt")
	}
}
func TestArtifactRetryAfter(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Retry-After", "120"); w.WriteHeader(429) })
	if _, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0); err == nil {
		t.Fatal("429 accepted")
	}
	if transport.RetryAfterMillis() < 119000 {
		t.Fatal("retry hint lost")
	}
}
func TestArtifactCompletePartialPublishesWithoutNetwork(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	address := "https://example.com/app.apk"
	seedArtifact(t, dir, address, digest, body, `"one"`, len(body))
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unneeded network") })
	if _, err := transport.DownloadArtifact(dir, address, digest, int64(len(body)), 0); err != nil {
		t.Fatal(err)
	}
}
func TestArtifactWholeTransferDeadline(t *testing.T) {
	dir, body, digest := artifactFixture(t)
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	transport.cancel()
	transport.ctx, transport.cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
	if _, err := transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0); err == nil {
		t.Fatal("deadline ignored")
	}
}

func TestArtifactKilledPublication(t *testing.T) {
	if dir := os.Getenv("OTA_ARTIFACT_KILL_DIR"); dir != "" {
		_, err := publishArtifact(filepath.Join(dir, "staged.part"), filepath.Join(dir, "complete.apk"), dir, func(point string) {
			if point == os.Getenv("OTA_ARTIFACT_KILL_POINT") {
				os.Exit(42)
			}
		})
		t.Fatalf("kill boundary not reached: %v", err)
	}
	for _, point := range []string{"before-rename", "renamed", "published"} {
		t.Run(point, func(t *testing.T) {
			dir, body, digest := artifactFixture(t)
			file, err := os.OpenFile(filepath.Join(dir, "staged.part"), os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = file.Write(body); err != nil {
				t.Fatal(err)
			}
			if err = file.Sync(); err != nil {
				t.Fatal(err)
			}
			file.Close()
			child := exec.Command(os.Args[0], "-test.run=^TestArtifactKilledPublication$")
			child.Env = append(os.Environ(), "OTA_ARTIFACT_KILL_DIR="+dir, "OTA_ARTIFACT_KILL_POINT="+point)
			err = child.Run()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 42 {
				t.Fatalf("child: %v", err)
			}
			name := "complete.apk"
			if point == "before-rename" {
				name = "staged.part"
			}
			if err = verifyArtifact(filepath.Join(dir, name), digest, int64(len(body))); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestArtifactSeparateBudgetAndIdleTimeout(t *testing.T) {
	d, err := NewArtifactDownloaderWithTimeSource("example.com", &fixtureTimeSource{bounds: TrustedTimeInterval{now.UnixMilli(), now.UnixMilli()}})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	deadline, ok := d.transport.ctx.Deadline()
	if !ok || time.Until(deadline) < 29*time.Minute || d.transport.client.Timeout != 0 {
		t.Fatal("large transfer budget missing")
	}
	dir, body, digest := artifactFixture(t)
	transport, _ := localHTTPS(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	transport.client.Timeout = 0
	transport.artifactIdleTimeout = 30 * time.Millisecond
	started := time.Now()
	if _, err = transport.DownloadArtifact(dir, "https://example.com/app.apk", digest, int64(len(body)), 0); err == nil {
		t.Fatal("idle accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("idle timeout ineffective")
	}
}
