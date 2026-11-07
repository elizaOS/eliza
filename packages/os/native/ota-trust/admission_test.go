package otatrust

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type admissionVector struct {
	Name     string          `json:"name"`
	Release  json.RawMessage `json:"release"`
	Device   json.RawMessage `json:"device"`
	Policy   json.RawMessage `json:"policy"`
	Expected struct {
		Error            bool   `json:"error"`
		Decision         string `json:"decision"`
		Reason           string `json:"reason"`
		EffectiveChannel string `json:"effectiveChannel"`
		ReleaseID        string `json:"releaseId"`
		Sequence         int64  `json:"sequence"`
		Candidate        string `json:"candidateSha256"`
		Recovery         string `json:"recoverySha256"`
	} `json:"expected"`
}

// The identity testdata/admission.json is written for: the TestMain default.
const (
	vectorProduct      = "example-app"
	vectorPackage      = "com.example.app"
	vectorCohortDomain = "example-app-ota-v1"
)

var (
	vectorProductField = regexp.MustCompile(`("product":\s*)"` + regexp.QuoteMeta(vectorProduct) + `"`)
	vectorPackageField = regexp.MustCompile(`("packageId":\s*)"` + regexp.QuoteMeta(vectorPackage) + `"`)
)

func admissionVectors(t *testing.T) []admissionVector {
	t.Helper()
	var vectors []admissionVector
	if err := json.Unmarshal(hostVectorData(t), &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

// hostVectorData returns testdata/admission.json bound to the compiled host
// policy, so a host build (and its Android fixture export) runs the vectors
// under its own product. Descriptors naming the vector product and package are
// rebound; others keep their deliberate mismatch. The cohort-boundary
// thresholds are rederived from the host cohort domain, so they still sit on
// the bucket boundary. Every other byte is unchanged, including the formatting
// the parser-ambiguity mutations match.
func hostVectorData(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/admission.json")
	if err != nil {
		t.Fatal(err)
	}
	host, err := requiredHostPolicy()
	if err != nil {
		t.Fatal(err)
	}
	product, _ := json.Marshal(host.Product)
	pkg, _ := json.Marshal(host.Package)
	data = vectorProductField.ReplaceAll(data, append([]byte("${1}"), product...))
	data = vectorPackageField.ReplaceAll(data, append([]byte("${1}"), pkg...))
	if host.CohortDomain == vectorCohortDomain {
		return data
	}
	var vectors []admissionVector
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	offset := map[string]int64{"cohort-boundary-excluded": 0, "cohort-boundary-included": 1}
	for _, v := range vectors {
		delta, boundary := offset[v.Name]
		if !boundary {
			continue
		}
		var release releaseDescriptor
		var device admissionDevice
		if json.Unmarshal(v.Release, &release) != nil || json.Unmarshal(v.Device, &device) != nil {
			t.Fatal("unreadable cohort-boundary vector", v.Name)
		}
		threshold := regexp.MustCompile(`("name":\s*"` + regexp.QuoteMeta(v.Name) + `",[\s\S]*?"threshold":\s*)\d+`)
		if len(threshold.FindAll(data, -1)) != 1 {
			t.Fatal("cohort-boundary threshold not found", v.Name)
		}
		data = threshold.ReplaceAll(data, []byte("${1}"+strconv.FormatInt(cohortBucket(host.CohortDomain, release.Rollout.Seed, device.CohortID)+delta, 10)))
	}
	return data
}
func TestNativeAdmissionReferenceParity(t *testing.T) {
	for _, v := range admissionVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			result, err := EvaluateReleaseInterval(v.Release, v.Device, v.Policy)
			if v.Expected.Error {
				if err == nil || result != nil {
					t.Fatal("invalid reference vector accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			e := v.Expected
			if result.Decision != e.Decision || result.Reason != e.Reason || result.EffectiveChannel != e.EffectiveChannel || result.ReleaseID != e.ReleaseID || result.Sequence != e.Sequence || result.CandidateSHA256 != e.Candidate || result.RecoverySHA256 != e.Recovery {
				t.Fatalf("got %+v want %+v", result, e)
			}
		})
	}
}
func TestNativeAdmissionRejectsParserAmbiguity(t *testing.T) {
	v := admissionVectors(t)[0]
	for _, replacement := range []string{`"schemaVersion":null`, `"schemaVersion":1e0`, `"schemaVersion":1.0`, `"schemaVersion":-0`, `"SchemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, `"schemaVersion":9007199254740993`} {
		data := bytes.Replace(v.Release, []byte(`"schemaVersion": 1`), []byte(replacement), 1)
		if bytes.Equal(data, v.Release) {
			t.Fatal("mutation missed")
		}
		if result, err := EvaluateReleaseInterval(data, v.Device, v.Policy); err == nil || result != nil {
			t.Fatal("ambiguous JSON accepted", replacement)
		}
	}
	for _, data := range [][]byte{append(append([]byte{}, v.Release...), []byte(" {}")...), []byte(strings.Repeat(" ", int(maxBytes)+1)), {0xc3, 0x28}, bytes.Replace(v.Release, []byte(`"product": "`), []byte(`"product": "\ud800`), 1)} {
		if _, err := EvaluateReleaseInterval(data, v.Device, v.Policy); err == nil {
			t.Fatal("bad encoding/bound accepted")
		}
	}
}
