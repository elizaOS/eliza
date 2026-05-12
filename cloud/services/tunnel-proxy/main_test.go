package main

import (
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestValidTunnelHostLabelRequiresSignedUnexpiredHostname(t *testing.T) {
	secret := "test-signing-secret"
	expiresAt := time.Now().Add(time.Hour).Unix()
	payload := fmt.Sprintf("eliza-org-0123456789abcdefabcd-%s", formatBase36(expiresAt))
	label := payload + "-" + tunnelHostSignature(payload, secret)

	if !validTunnelHostLabel(label, secret, false, time.Now()) {
		t.Fatalf("expected signed unexpired label to be valid")
	}
	if validTunnelHostLabel(label+"0", secret, false, time.Now()) {
		t.Fatalf("expected tampered label to be invalid")
	}
	if validTunnelHostLabel("eliza-org-0123456789abcdefabcd", secret, false, time.Now()) {
		t.Fatalf("expected unsigned label to be invalid when signing is configured")
	}
}

func TestValidTunnelHostLabelRejectsExpiredSignedHostname(t *testing.T) {
	secret := "test-signing-secret"
	expiresAt := time.Now().Add(-time.Minute).Unix()
	payload := fmt.Sprintf("eliza-org-0123456789abcdefabcd-%s", formatBase36(expiresAt))
	label := payload + "-" + tunnelHostSignature(payload, secret)

	if validTunnelHostLabel(label, secret, false, time.Now()) {
		t.Fatalf("expected expired signed label to be invalid")
	}
}

func TestValidTunnelHostLabelUnsignedDevMode(t *testing.T) {
	label := "eliza-org-0123456789abcdefabcd"
	if validTunnelHostLabel(label, "", false, time.Now()) {
		t.Fatalf("expected unsigned label to be invalid when unsigned mode is disabled")
	}
	if !validTunnelHostLabel(label, "", true, time.Now()) {
		t.Fatalf("expected unsigned label to be valid when unsigned mode is enabled")
	}
}

func TestTargetHostForRequest(t *testing.T) {
	secret := "test-signing-secret"
	expiresAt := time.Now().Add(time.Hour).Unix()
	payload := fmt.Sprintf("eliza-org-0123456789abcdefabcd-%s", formatBase36(expiresAt))
	label := payload + "-" + tunnelHostSignature(payload, secret)

	target, ok := targetHostForRequest(
		label+".tunnel.elizacloud.ai",
		"tunnel.elizacloud.ai",
		"tunnel.eliza.local",
		secret,
		false,
	)
	if !ok {
		t.Fatalf("expected signed public host to resolve")
	}
	if want := label + ".tunnel.eliza.local"; target != want {
		t.Fatalf("target host = %q, want %q", target, want)
	}
}

func formatBase36(value int64) string {
	return strconv.FormatInt(value, 36)
}
