package otatrust

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"testing"
)

// roughtimeResponder is a test-only authority with generated keys.
type roughtimeResponder struct {
	longTerm, delegated ed25519.PrivateKey
	midpoint, maxTime   uint64
}

func newRoughtimeResponder(t *testing.T) *roughtimeResponder {
	t.Helper()
	_, longTerm, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, delegated, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &roughtimeResponder{longTerm: longTerm, delegated: delegated, midpoint: 1_800_000_000, maxTime: 1<<64 - 1}
}

func (r *roughtimeResponder) publicKey() []byte { return r.longTerm.Public().(ed25519.PublicKey) }

func le64(value uint64) []byte { return binary.LittleEndian.AppendUint64(nil, value) }

func (r *roughtimeResponder) respond(t *testing.T, packet []byte, fault string) []byte {
	t.Helper()
	request, err := roughtimeUnframe(packet)
	if err != nil {
		t.Fatal(err)
	}
	version, _ := request.uint32("VER")
	nonce, _ := request.get("NONC", roughtimeNonceBytes)
	draft12 := int64(version) == RoughtimeDraft12
	leafData := nonce
	if draft12 {
		leafData = packet
	}
	if fault == "wrong nonce" {
		leafData = append([]byte{}, leafData...)
		leafData[len(leafData)-1] ^= 1
		if !draft12 {
			nonce = leafData
		}
	}
	root, path, index := roughtimeHash(0, leafData, nil), []byte{}, uint32(0)
	if fault == "sibling leaf" {
		// A valid two-leaf tree in which this request is the right-hand leaf.
		other := roughtimeHash(0, []byte{9, 9, 9}, nil)
		path, index, root = other, 1, roughtimeHash(1, other, root)
	}
	signedVersion := version
	if fault == "wrong version" {
		signedVersion++
	}
	srep := map[uint32][]byte{roughtimeTag("ROOT"): root, roughtimeTag("MIDP"): le64(r.midpoint), roughtimeTag("RADI"): le32(1)}
	if draft12 {
		srep[roughtimeTag("VER")] = le32(signedVersion)
		srep[roughtimeTag("VERS")] = concat(le32(uint32(RoughtimeDraft11)), le32(uint32(RoughtimeDraft12)))
	}
	srepBytes := roughtimeEncode(srep)
	maxTime := r.maxTime
	if fault == "expired delegation" {
		maxTime = r.midpoint - 1
	}
	deleBytes := roughtimeEncode(map[uint32][]byte{roughtimeTag("PUBK"): r.delegated.Public().(ed25519.PublicKey), roughtimeTag("MINT"): le64(0), roughtimeTag("MAXT"): le64(maxTime)})
	context := roughtimeDraft11Delegation
	if draft12 || fault == "draft 12 context on draft 11" {
		context = roughtimeDelegation
	}
	deleSigner, srepSigner := r.longTerm, r.delegated
	if fault == "bad delegation signature" {
		deleSigner = r.delegated
	}
	if fault == "bad response signature" {
		srepSigner = r.longTerm
	}
	cert := roughtimeEncode(map[uint32][]byte{roughtimeTag("SIG"): ed25519.Sign(deleSigner, concat(context, deleBytes)), roughtimeTag("DELE"): deleBytes})
	top := map[uint32][]byte{
		roughtimeTag("SIG"):  ed25519.Sign(srepSigner, concat(roughtimeResponse, srepBytes)),
		roughtimeTag("SREP"): srepBytes,
		roughtimeTag("CERT"): cert,
		roughtimeTag("PATH"): path,
		roughtimeTag("INDX"): le32(index),
	}
	if draft12 {
		top[roughtimeTag("NONC")] = nonce
		kind := uint32(1)
		if fault == "wrong type" {
			kind = 0
		}
		top[roughtimeTag("TYPE")] = le32(kind)
	} else {
		top[roughtimeTag("VER")] = le32(signedVersion)
	}
	response := roughtimeFrame(roughtimeEncode(top))
	if fault == "truncated" {
		return response[:len(response)-4]
	}
	return response
}

func TestRoughtimeVerifiesBothDrafts(t *testing.T) {
	for _, version := range []int64{RoughtimeDraft11, RoughtimeDraft12} {
		for _, fault := range []string{"", "sibling leaf"} {
			responder := newRoughtimeResponder(t)
			request, err := NewRoughtimeRequest(version)
			if err != nil {
				t.Fatal(err)
			}
			if len(request.Packet()) != roughtimeRequestBytes {
				t.Fatalf("request is %d bytes", len(request.Packet()))
			}
			verified, err := VerifyRoughtimeResponse(request, responder.respond(t, request.Packet(), fault), responder.publicKey())
			if err != nil {
				t.Fatalf("version %x %q: %v", version, fault, err)
			}
			if verified.MidpointSeconds != int64(responder.midpoint) || verified.RadiusSeconds != 1 || len(verified.ResponseDigest) != 32 {
				t.Fatalf("version %x %q: unexpected result %+v", version, fault, verified)
			}
		}
	}
}

func TestRoughtimeRejectsUnauthenticatedResponses(t *testing.T) {
	faults := []string{"wrong nonce", "bad response signature", "bad delegation signature", "expired delegation", "wrong version", "truncated"}
	cases := map[int64][]string{
		RoughtimeDraft11: append(faults, "draft 12 context on draft 11"),
		RoughtimeDraft12: append(faults, "wrong type"),
	}
	for version, faults := range cases {
		for _, fault := range faults {
			responder := newRoughtimeResponder(t)
			request, err := NewRoughtimeRequest(version)
			if err != nil {
				t.Fatal(err)
			}
			if verified, err := VerifyRoughtimeResponse(request, responder.respond(t, request.Packet(), fault), responder.publicKey()); err == nil {
				t.Fatalf("version %x accepted %q: %+v", version, fault, verified)
			}
		}
		responder := newRoughtimeResponder(t)
		request, _ := NewRoughtimeRequest(version)
		other := newRoughtimeResponder(t)
		if _, err := VerifyRoughtimeResponse(request, responder.respond(t, request.Packet(), ""), other.publicKey()); err == nil {
			t.Fatalf("version %x accepted a response from an unprovisioned key", version)
		}
	}
	if _, err := NewRoughtimeRequest(0x80000007); err == nil {
		t.Fatal("unsupported version accepted")
	}
}
