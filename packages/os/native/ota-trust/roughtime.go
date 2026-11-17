package otatrust

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"sort"
)

// Roughtime (draft-ietf-ntp-roughtime) client verification for native hosts
// that build a TrustedTimeSource. Android platform providers expose Ed25519
// only for Keystore keys, so a Java host cannot verify an authority's key
// without a separate crypto library. These functions perform no I/O and read no
// clock. The host sends the request, measures the round trip, combines
// authorities and owns the boot-scoped anchor; none of that is done here.
const (
	RoughtimeDraft11 int64 = 0x8000000b
	RoughtimeDraft12 int64 = 0x8000000c

	roughtimeRequestBytes = 1024
	roughtimeNonceBytes   = 32
	roughtimeMaxTags      = 32
	roughtimeMaxBytes     = 4096
	roughtimeMaxPathNodes = 32
)

var (
	roughtimeMagic = []byte("ROUGHTIM")
	// Draft 11 and earlier sign delegations under the original context.
	roughtimeDraft11Delegation = []byte("RoughTime v1 delegation signature--\x00")
	roughtimeDelegation        = []byte("RoughTime v1 delegation signature\x00")
	roughtimeResponse          = []byte("RoughTime v1 response signature\x00")
)

// RoughtimeRequest is one nonce-bound request. Send Packet unchanged.
type RoughtimeRequest struct {
	version uint32
	nonce   []byte
	packet  []byte
}

// RoughtimeTime is a verified response. Times are whole seconds as signed by
// the authority; the caller adds its own round-trip uncertainty.
type RoughtimeTime struct {
	MidpointSeconds int64
	RadiusSeconds   int64
	// ResponseDigest is the SHA-256 of the response packet, for evidence.
	ResponseDigest []byte
}

// NewRoughtimeRequest makes a 1024-byte framed request with a random nonce.
func NewRoughtimeRequest(version int64) (*RoughtimeRequest, error) {
	nonce := make([]byte, roughtimeNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return newRoughtimeRequest(version, nonce)
}

func newRoughtimeRequest(version int64, nonce []byte) (*RoughtimeRequest, error) {
	if version != RoughtimeDraft11 && version != RoughtimeDraft12 {
		return nil, errors.New("unsupported Roughtime version")
	}
	entries := map[uint32][]byte{roughtimeTag("VER"): le32(uint32(version)), roughtimeTag("NONC"): nonce}
	if version == RoughtimeDraft12 {
		entries[roughtimeTag("TYPE")] = le32(0)
	}
	used := 12 + 8*(len(entries)+1)
	for _, value := range entries {
		used += len(value)
	}
	entries[roughtimeTag("ZZZZ")] = make([]byte, roughtimeRequestBytes-used)
	packet := roughtimeFrame(roughtimeEncode(entries))
	return &RoughtimeRequest{version: uint32(version), nonce: bytes.Clone(nonce), packet: packet}, nil
}

// Packet returns a copy of the framed UDP request.
func (r *RoughtimeRequest) Packet() []byte { return bytes.Clone(r.packet) }

// VerifyRoughtimeResponse verifies the delegation signature by the provisioned
// long-term key, the response signature, nonce and version binding, the Merkle
// path and the delegation window. Any failure returns an error and no time.
func VerifyRoughtimeResponse(request *RoughtimeRequest, response, longTermPublicKey []byte) (*RoughtimeTime, error) {
	if request == nil || len(longTermPublicKey) != ed25519.PublicKeySize {
		return nil, errors.New("invalid Roughtime request or public key")
	}
	top, err := roughtimeUnframe(response)
	if err != nil {
		return nil, err
	}
	signature, err := top.get("SIG", ed25519.SignatureSize)
	if err != nil {
		return nil, err
	}
	srepBytes, err := top.get("SREP", -1)
	if err != nil {
		return nil, err
	}
	srep, err := top.nested("SREP")
	if err != nil {
		return nil, err
	}
	cert, err := top.nested("CERT")
	if err != nil {
		return nil, err
	}
	deleBytes, err := cert.get("DELE", -1)
	if err != nil {
		return nil, err
	}
	dele, err := roughtimeParse(deleBytes)
	if err != nil {
		return nil, err
	}
	deleSignature, err := cert.get("SIG", ed25519.SignatureSize)
	if err != nil {
		return nil, err
	}
	context := roughtimeDraft11Delegation
	if int64(request.version) == RoughtimeDraft12 {
		context = roughtimeDelegation
	}
	if !ed25519.Verify(longTermPublicKey, concat(context, deleBytes), deleSignature) {
		return nil, errors.New("Roughtime delegation is not signed by the provisioned key")
	}
	delegated, err := dele.get("PUBK", ed25519.PublicKeySize)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(delegated, concat(roughtimeResponse, srepBytes), signature) {
		return nil, errors.New("Roughtime response is not signed by the delegated key")
	}

	leaf := request.nonce
	if int64(request.version) == RoughtimeDraft12 {
		// Draft 12 hashes the framed request, binding every request field.
		leaf = request.packet
		nonce, err := top.get("NONC", roughtimeNonceBytes)
		if err != nil || subtle.ConstantTimeCompare(nonce, request.nonce) != 1 {
			return nil, errors.New("Roughtime nonce mismatch")
		}
		if kind, err := top.uint32("TYPE"); err != nil || kind != 1 {
			return nil, errors.New("Roughtime response type mismatch")
		}
		if version, err := srep.uint32("VER"); err != nil || version != request.version {
			return nil, errors.New("Roughtime version mismatch")
		}
		offered, err := srep.get("VERS", -1)
		if err != nil || len(offered) < 4 || len(offered) > 128 {
			return nil, errors.New("invalid Roughtime version list")
		}
		listed, previous := false, int64(-1)
		for i := 0; i < len(offered); i += 4 {
			version := int64(binary.LittleEndian.Uint32(offered[i:]))
			if version <= previous {
				return nil, errors.New("unsorted Roughtime version list")
			}
			previous, listed = version, listed || version == int64(request.version)
		}
		if !listed {
			return nil, errors.New("Roughtime version not offered")
		}
	} else if version, err := top.uint32("VER"); err != nil || version != request.version {
		return nil, errors.New("Roughtime version mismatch")
	}

	path, err := top.get("PATH", -1)
	if err != nil || len(path)%32 != 0 || len(path)/32 > roughtimeMaxPathNodes {
		return nil, errors.New("invalid Roughtime Merkle path")
	}
	index, err := top.uint32("INDX")
	if err != nil {
		return nil, err
	}
	signedRoot, err := srep.get("ROOT", 32)
	if err != nil {
		return nil, err
	}
	root, err := roughtimeMerkleRoot(leaf, path, index)
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(root, signedRoot) != 1 {
		return nil, errors.New("Roughtime response does not include this request")
	}

	midpoint, err := srep.uint64("MIDP")
	if err != nil {
		return nil, err
	}
	radius, err := srep.uint32("RADI")
	if err != nil {
		return nil, err
	}
	minTime, err := dele.uint64("MINT")
	if err != nil {
		return nil, err
	}
	maxTime, err := dele.uint64("MAXT")
	if err != nil {
		return nil, err
	}
	if minTime > maxTime || midpoint < minTime || midpoint > maxTime {
		return nil, errors.New("Roughtime time outside delegation validity")
	}
	if radius < 1 || midpoint > uint64(safeInteger/1000) {
		return nil, errors.New("Roughtime time out of range")
	}
	digest := sha256.Sum256(response)
	return &RoughtimeTime{MidpointSeconds: int64(midpoint), RadiusSeconds: int64(radius), ResponseDigest: digest[:]}, nil
}

func roughtimeMerkleRoot(leaf, path []byte, index uint32) ([]byte, error) {
	hash := roughtimeHash(0, leaf, nil)
	for offset := 0; offset < len(path); offset += 32 {
		sibling := path[offset : offset+32]
		if index&1 == 0 {
			hash = roughtimeHash(1, hash, sibling)
		} else {
			hash = roughtimeHash(1, sibling, hash)
		}
		index >>= 1
	}
	if index != 0 {
		return nil, errors.New("Roughtime Merkle index exceeds path")
	}
	return hash, nil
}

func roughtimeHash(prefix byte, a, b []byte) []byte {
	digest := sha512.New()
	digest.Write([]byte{prefix})
	digest.Write(a)
	digest.Write(b)
	return digest.Sum(nil)[:32]
}

// roughtimeTag reads up to four ASCII bytes, NUL padded, as a little-endian uint32.
func roughtimeTag(name string) uint32 {
	var tag [4]byte
	copy(tag[:], name)
	return binary.LittleEndian.Uint32(tag[:])
}

type roughtimeMessage map[uint32][]byte

func roughtimeEncode(entries map[uint32][]byte) []byte {
	tags := make([]uint32, 0, len(entries))
	for tag := range entries {
		tags = append(tags, tag)
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i] < tags[j] })
	out := le32(uint32(len(tags)))
	offset := 0
	for i, tag := range tags {
		if i > 0 {
			out = append(out, le32(uint32(offset))...)
		}
		offset += len(entries[tag])
	}
	for _, tag := range tags {
		out = append(out, le32(tag)...)
	}
	for _, tag := range tags {
		out = append(out, entries[tag]...)
	}
	return out
}

func roughtimeParse(message []byte) (roughtimeMessage, error) {
	malformed := errors.New("malformed Roughtime message")
	if len(message) < 4 || len(message) > roughtimeMaxBytes || len(message)%4 != 0 {
		return nil, malformed
	}
	count := int(binary.LittleEndian.Uint32(message))
	if count < 1 || count > roughtimeMaxTags || 8*count > len(message) {
		return nil, malformed
	}
	header, values := 8*count, len(message)-8*count
	offsets := make([]int, count+1)
	for i := 1; i < count; i++ {
		offset := int(binary.LittleEndian.Uint32(message[4*i:]))
		if offset%4 != 0 || offset < offsets[i-1] || offset > values {
			return nil, malformed
		}
		offsets[i] = offset
	}
	offsets[count] = values
	parsed, previous := roughtimeMessage{}, int64(-1)
	for i := 0; i < count; i++ {
		tag := binary.LittleEndian.Uint32(message[4*count+4*i:])
		if int64(tag) <= previous {
			return nil, errors.New("Roughtime tags must strictly increase")
		}
		previous = int64(tag)
		parsed[tag] = bytes.Clone(message[header+offsets[i] : header+offsets[i+1]])
	}
	return parsed, nil
}

func roughtimeFrame(message []byte) []byte {
	return concat(roughtimeMagic, le32(uint32(len(message))), message)
}

func roughtimeUnframe(packet []byte) (roughtimeMessage, error) {
	if len(packet) < 16 || len(packet) > roughtimeMaxBytes+12 || !bytes.Equal(packet[:8], roughtimeMagic) || int(binary.LittleEndian.Uint32(packet[8:])) != len(packet)-12 {
		return nil, errors.New("malformed Roughtime packet")
	}
	return roughtimeParse(packet[12:])
}

func (m roughtimeMessage) get(name string, length int) ([]byte, error) {
	value, ok := m[roughtimeTag(name)]
	if !ok {
		return nil, errors.New("missing Roughtime " + name)
	}
	if length >= 0 && len(value) != length {
		return nil, errors.New("invalid Roughtime " + name + " length")
	}
	return value, nil
}

func (m roughtimeMessage) nested(name string) (roughtimeMessage, error) {
	value, err := m.get(name, -1)
	if err != nil {
		return nil, err
	}
	return roughtimeParse(value)
}

func (m roughtimeMessage) uint32(name string) (uint32, error) {
	value, err := m.get(name, 4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(value), nil
}

func (m roughtimeMessage) uint64(name string) (uint64, error) {
	value, err := m.get(name, 8)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(value), nil
}

func le32(value uint32) []byte { return binary.LittleEndian.AppendUint32(nil, value) }

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}
