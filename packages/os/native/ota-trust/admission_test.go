package otatrust

import (
	"bytes"
	"encoding/json"
	"os"
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

func admissionVectors(t *testing.T) []admissionVector {
	t.Helper()
	data, err := os.ReadFile("testdata/admission.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []admissionVector
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
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
	for _, data := range [][]byte{append(append([]byte{}, v.Release...), []byte(" {}")...), []byte(strings.Repeat(" ", int(maxBytes)+1)), {0xc3, 0x28}, bytes.Replace(v.Release, []byte(`"senior-care"`), []byte(`"\ud800"`), 1)} {
		if _, err := EvaluateReleaseInterval(data, v.Device, v.Policy); err == nil {
			t.Fatal("bad encoding/bound accepted")
		}
	}
}
