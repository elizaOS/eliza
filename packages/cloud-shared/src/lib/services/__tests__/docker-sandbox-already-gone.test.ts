/**
 * Covers the substring matcher that decides whether a failed `docker stop`
 * / `docker rm` error indicates the container is already absent. This is
 * the pivot of the prod fix shipped in PR #BIG — without it, both-calls-
 * failed used to silently leave zombie containers on the cores; with it,
 * both-calls-failed throws only when the failures are unrelated to "gone".
 */
import { describe, expect, test } from "bun:test";
import { isAlreadyGoneMessage, isNodeUnreachableMessage } from "../docker-error-classifier";

describe("isAlreadyGoneMessage", () => {
  test('recognizes "No such container" (Docker 24)', () => {
    expect(
      isAlreadyGoneMessage("Error response from daemon: No such container: agent-abc123"),
    ).toBe(true);
  });

  test('recognizes "not found" (older Docker)', () => {
    expect(isAlreadyGoneMessage("Container not found: agent-abc")).toBe(true);
  });

  test('recognizes "already gone"', () => {
    expect(isAlreadyGoneMessage("container already gone before stop")).toBe(true);
  });

  test('recognizes "no longer exists"', () => {
    expect(isAlreadyGoneMessage("the named container no longer exists on host")).toBe(true);
  });

  test("case-insensitive", () => {
    expect(isAlreadyGoneMessage("NO SUCH CONTAINER: AGENT-1")).toBe(true);
  });

  test("returns false for SSH connection failure", () => {
    expect(
      isAlreadyGoneMessage("ssh: connect to host 138.201.80.125 port 22: Connection timed out"),
    ).toBe(false);
  });

  test("returns false for Docker daemon down", () => {
    expect(
      isAlreadyGoneMessage("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
    ).toBe(false);
  });

  test("returns false for permission denied", () => {
    expect(isAlreadyGoneMessage("Permission denied (publickey)")).toBe(false);
  });

  test("returns false for empty / unrelated text", () => {
    expect(isAlreadyGoneMessage("")).toBe(false);
    expect(isAlreadyGoneMessage("some unrelated error")).toBe(false);
  });

  // The unreachable-node classifier must NOT overlap with the already-gone
  // classifier: an SSH "timed out" is unreachable (terminal-but-orphan), not
  // "gone". If isAlreadyGoneMessage matched it, the provider would log "already
  // absent" and skip the unreachable warn path.
  test("stays false for SSH timeout (handled by isNodeUnreachableMessage instead)", () => {
    expect(
      isAlreadyGoneMessage("[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms"),
    ).toBe(false);
  });
});

describe("isNodeUnreachableMessage", () => {
  test("recognizes SSH connect timeout", () => {
    expect(
      isNodeUnreachableMessage(
        "[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms",
      ),
    ).toBe(true);
  });

  // FALSE-POSITIVE GUARD: the docker-ssh PER-COMMAND timeout fires on a
  // REACHABLE-but-slow node (daemon hung/overloaded, container ignoring
  // SIGTERM, disk-I/O stall). It must NOT classify as unreachable — otherwise a
  // live container would be terminally deleted. Only CONNECT-phase timeouts
  // ("Connection to <host>:<port> timed out") count as unreachable.
  test("does NOT classify a per-command timeout as unreachable (reachable-but-slow node)", () => {
    expect(
      isNodeUnreachableMessage(
        "[docker-ssh] Command timed out after 25000ms on host: docker [redacted]",
      ),
    ).toBe(false);
  });

  test("still classifies a connect timeout as unreachable", () => {
    expect(
      isNodeUnreachableMessage(
        "[docker-ssh] Connection to 138.201.80.125:22 timed out after 10000ms",
      ),
    ).toBe(true);
  });

  test("recognizes ECONNREFUSED", () => {
    expect(isNodeUnreachableMessage("ECONNREFUSED 1.2.3.4:22")).toBe(true);
  });

  test("recognizes no route to host", () => {
    expect(isNodeUnreachableMessage("connect EHOSTUNREACH: no route to host")).toBe(true);
  });

  test("recognizes ENETUNREACH", () => {
    expect(isNodeUnreachableMessage("connect ENETUNREACH 10.0.0.1:22")).toBe(true);
  });

  test("recognizes DNS failure (getaddrinfo)", () => {
    expect(isNodeUnreachableMessage("getaddrinfo ENOTFOUND core-7.example")).toBe(true);
  });

  test("recognizes generic connection error", () => {
    expect(isNodeUnreachableMessage("ssh connection error during handshake")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(
      isNodeUnreachableMessage("[DOCKER-SSH] CONNECTION TO 1.2.3.4:22 TIMED OUT AFTER 10000MS"),
    ).toBe(true);
  });

  // The whole point of keeping the list NARROW: a real Docker-daemon error must
  // NOT be classified as unreachable (that would silently abandon a container
  // that is actually still running on a reachable node).
  test("returns false for a Docker daemon 'No such container' error", () => {
    expect(isNodeUnreachableMessage("Error response from daemon: No such container")).toBe(false);
  });

  test("returns false for generic / empty text (no 'error'-only match)", () => {
    expect(isNodeUnreachableMessage("")).toBe(false);
    expect(isNodeUnreachableMessage("some unrelated error")).toBe(false);
    expect(isNodeUnreachableMessage("Permission denied (publickey)")).toBe(false);
  });
});
