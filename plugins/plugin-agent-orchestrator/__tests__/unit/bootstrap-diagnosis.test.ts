/**
 * Verifies diagnoseWorkspaceBootstrapFailure.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { diagnoseWorkspaceBootstrapFailure } from "../../src/services/repo-input.js";

// #9146 — when a coding-agent workspace clone fails, the orchestrator turns the
// raw git error into an actionable diagnosis. Pin the branch routing so each
// failure mode maps to the right operator guidance.
const CLONE_URL = "https://github.com/owner/repo.git";

describe("diagnoseWorkspaceBootstrapFailure", () => {
  it("flags a malformed repo reference (input changed under normalization)", () => {
    const msg = diagnoseWorkspaceBootstrapFailure(
      "owner/repo",
      "fatal: could not resolve host",
    );
    expect(msg).toContain("looked malformed");
    expect(msg).toContain(CLONE_URL); // suggests the normalized remote
  });

  it("maps 'repository not found' to a not-found/access diagnosis", () => {
    const msg = diagnoseWorkspaceBootstrapFailure(
      CLONE_URL,
      "remote: Repository not found",
    );
    expect(msg).toContain("could not be found");
  });

  it("maps auth errors to a credentials diagnosis", () => {
    const msg = diagnoseWorkspaceBootstrapFailure(
      CLONE_URL,
      "fatal: Authentication failed",
    );
    expect(msg).toContain("Git authentication failed");
  });

  it("maps DNS errors (already-normalized repo) to a network diagnosis", () => {
    const msg = diagnoseWorkspaceBootstrapFailure(
      CLONE_URL,
      "could not resolve host",
    );
    expect(msg).toContain("DNS or network");
  });

  it("falls back to a generic bootstrap-failure message", () => {
    const msg = diagnoseWorkspaceBootstrapFailure(
      CLONE_URL,
      "unexpected gremlin",
    );
    expect(msg).toContain("exhausted its automatic recovery");
  });
});
