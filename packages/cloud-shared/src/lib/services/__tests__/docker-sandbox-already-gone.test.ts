/**
 * Covers the substring matcher that decides whether a failed `docker stop`
 * / `docker rm` error indicates the container is already absent. This is
 * the pivot of the prod fix shipped in PR #BIG — without it, both-calls-
 * failed used to silently leave zombie containers on the cores; with it,
 * both-calls-failed throws only when the failures are unrelated to "gone".
 */
import { describe, expect, test } from "bun:test";
import { isAlreadyGoneMessage } from "../docker-error-classifier";

describe("isAlreadyGoneMessage", () => {
  test('recognizes "No such container" (Docker 24)', () => {
    expect(
      isAlreadyGoneMessage(
        "Error response from daemon: No such container: agent-abc123",
      ),
    ).toBe(true);
  });

  test('recognizes "not found" (older Docker)', () => {
    expect(isAlreadyGoneMessage("Container not found: agent-abc")).toBe(true);
  });

  test('recognizes "already gone"', () => {
    expect(isAlreadyGoneMessage("container already gone before stop")).toBe(
      true,
    );
  });

  test('recognizes "no longer exists"', () => {
    expect(
      isAlreadyGoneMessage("the named container no longer exists on host"),
    ).toBe(true);
  });

  test("case-insensitive", () => {
    expect(isAlreadyGoneMessage("NO SUCH CONTAINER: AGENT-1")).toBe(true);
  });

  test("returns false for SSH connection failure", () => {
    expect(
      isAlreadyGoneMessage(
        "ssh: connect to host 138.201.80.125 port 22: Connection timed out",
      ),
    ).toBe(false);
  });

  test("returns false for Docker daemon down", () => {
    expect(
      isAlreadyGoneMessage(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      ),
    ).toBe(false);
  });

  test("returns false for permission denied", () => {
    expect(isAlreadyGoneMessage("Permission denied (publickey)")).toBe(false);
  });

  test("returns false for empty / unrelated text", () => {
    expect(isAlreadyGoneMessage("")).toBe(false);
    expect(isAlreadyGoneMessage("some unrelated error")).toBe(false);
  });
});
