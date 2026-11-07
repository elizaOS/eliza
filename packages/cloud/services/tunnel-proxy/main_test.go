package main

import (
	"fmt"
	"net/http"
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

	aliases, err := parsePublicAliases("tunnel.elizacloud.ai")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{publicHost: "tunnel.eliza.app", publicAliases: aliases,
		tailnetDomain: "tunnel.eliza.local", signingSecret: secret}
	for _, host := range []string{label + ".tunnel.eliza.app", label + ".tunnel.elizacloud.ai"} {
		if got, ok := cfg.targetForRequest(host); !ok || got != target {
			t.Fatalf("configured hostname %q resolved to %q (%v), want %q", host, got, ok, target)
		}
	}
	for _, host := range []string{
		label + ".tunnel-staging.elizacloud.ai",
		label + ".tunnel.elizacloud.ai.evil.test",
		"prefix." + label + ".tunnel.elizacloud.ai",
		label + "0.tunnel.elizacloud.ai",
		"eliza-org-0123456789abcdefabcd.tunnel.elizacloud.ai",
		"tunnel.elizacloud.ai",
	} {
		if _, ok := cfg.targetForRequest(host); ok {
			t.Fatalf("untrusted or unsigned hostname %q was accepted", host)
		}
	}
	expiredPayload := fmt.Sprintf("eliza-org-0123456789abcdefabcd-%s", formatBase36(time.Now().Add(-time.Minute).Unix()))
	if _, ok := cfg.targetForRequest(expiredPayload + "-" + tunnelHostSignature(expiredPayload, secret) + ".tunnel.elizacloud.ai"); ok {
		t.Fatal("expired alias hostname was accepted")
	}
	for _, invalid := range []string{"*.tunnel.elizacloud.ai", "https://tunnel.elizacloud.ai", "tunnel.elizacloud.ai:443", ",tunnel.elizacloud.ai", "tunnel..elizacloud.ai"} {
		if _, err := parsePublicAliases(invalid); err == nil {
			t.Fatalf("invalid alias configuration %q was accepted", invalid)
		}
	}
}

func TestForwardedHostPreservesOriginalPublicHost(t *testing.T) {
	req, err := http.NewRequest("GET", "https://eliza-staging-1.elizacloud.ai/pair", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "eliza-staging-1.elizacloud.ai"
	req.Header.Set("X-Forwarded-Host", "agent-id.staging.elizacloud.ai")

	if got, want := forwardedHost(req), "agent-id.staging.elizacloud.ai"; got != want {
		t.Fatalf("forwardedHost() = %q, want %q", got, want)
	}
}

func TestForwardedHostFallsBackToRequestHost(t *testing.T) {
	req, err := http.NewRequest("GET", "https://tunnel.elizacloud.ai/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "tunnel.elizacloud.ai"

	if got, want := forwardedHost(req), "tunnel.elizacloud.ai"; got != want {
		t.Fatalf("forwardedHost() = %q, want %q", got, want)
	}
}

func formatBase36(value int64) string {
	return strconv.FormatInt(value, 36)
}
