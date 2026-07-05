/**
 * Error-policy coverage for the docker-stats parser (#13415).
 *
 * The parser feeds `HetznerClient.getMetrics`, whose snapshot drives container
 * monitoring/autoscaling. A malformed field (docker emitting `--` for an
 * unavailable container, a truncated line, or an unrecognized unit) must
 * surface as a typed `invalid_input` failure — it must NOT fabricate a
 * 0-byte/wrong-magnitude metric that reads as a healthy, idle container.
 * A legitimately-zero reading (`0B`, a `0B / 0B` idle net/block counter) is a
 * real datum and stays distinct: it parses to 0 without throwing.
 *
 * Pure parser, no external deps — the real exported function is exercised
 * directly, no mocks stand in for the code under test.
 */

import { describe, expect, it } from "bun:test";
import { parseDockerStats } from "./docker-stats";
import { HetznerClientError } from "./types";

const line = (cpu: string, mem: string, net: string, block: string) =>
  `${cpu}|${mem}|${net}|${block}`;

describe("parseDockerStats — designed-valid path", () => {
  it("parses a well-formed docker stats line with mixed decimal/binary units", () => {
    const snap = parseDockerStats(line("12.50%", "128MiB / 512MiB", "1.2kB / 3.4MB", "10MB / 0B"));
    expect(snap.cpuPercent).toBe(12.5);
    expect(snap.memoryBytes).toBe(Math.round(128 * 1024 ** 2));
    expect(snap.memoryLimitBytes).toBe(Math.round(512 * 1024 ** 2));
    expect(snap.netRxBytes).toBe(1200);
    expect(snap.netTxBytes).toBe(3_400_000);
    expect(snap.blockReadBytes).toBe(10_000_000);
    expect(snap.blockWriteBytes).toBe(0);
    expect(snap.capturedAt).toBeInstanceOf(Date);
  });

  it("keeps a legitimately-zero idle reading distinct (0B is a real datum, not a failure)", () => {
    const snap = parseDockerStats(line("0.00%", "0B / 0B", "0B / 0B", "0B / 0B"));
    expect(snap.memoryBytes).toBe(0);
    expect(snap.netRxBytes).toBe(0);
    expect(snap.blockWriteBytes).toBe(0);
  });

  it("uses only the last line of multi-line output", () => {
    const snap = parseDockerStats(
      `header-noise\n${line("1.00%", "1MiB / 2MiB", "1B / 1B", "1B / 1B")}`,
    );
    expect(snap.memoryBytes).toBe(1024 ** 2);
  });
});

describe("parseDockerStats — internal failure propagates (fail closed)", () => {
  it("throws invalid_input when docker emits `--` for an unavailable container", () => {
    // A restarting/dead container yields `-- / --`; that is missing data, not 0.
    let err: unknown;
    try {
      parseDockerStats(line("0.00%", "-- / --", "0B / 0B", "0B / 0B"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HetznerClientError);
    expect((err as HetznerClientError).code).toBe("invalid_input");
  });

  it("throws invalid_input on an unrecognized size unit (never silently treats it as bytes)", () => {
    let err: unknown;
    try {
      parseDockerStats(line("0.00%", "5ZiB / 10MiB", "0B / 0B", "0B / 0B"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HetznerClientError);
    expect((err as HetznerClientError).code).toBe("invalid_input");
    expect((err as HetznerClientError).message).toContain("Unknown size unit");
  });

  it("throws invalid_input on a truncated line with missing pipe-delimited fields", () => {
    let err: unknown;
    try {
      parseDockerStats("12.50%|128MiB / 512MiB");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HetznerClientError);
    expect((err as HetznerClientError).code).toBe("invalid_input");
  });

  it("throws invalid_input on malformed size-pair fields instead of leaking TypeError", () => {
    const malformed = [
      line("12.50%", "128MiB", "0B / 0B", "0B / 0B"),
      line("12.50%", "128MiB /", "0B / 0B", "0B / 0B"),
      line("12.50%", "128MiB / 512MiB / 1GiB", "0B / 0B", "0B / 0B"),
      line("12.50%", "128MiB / 512MiB", "1B", "0B / 0B"),
      line("12.50%", "128MiB / 512MiB", "0B / 0B", "1B / 2B / 3B"),
    ];
    for (const bad of malformed) {
      let err: unknown;
      try {
        parseDockerStats(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HetznerClientError);
      expect((err as HetznerClientError).code).toBe("invalid_input");
    }
  });

  it("throws invalid_input on empty output rather than fabricating a zero snapshot", () => {
    expect(() => parseDockerStats("")).toThrow(HetznerClientError);
  });

  it("rejects partial/multi-dot/NaN numeric tokens instead of truncating them (parseFloat leniency)", () => {
    // `parseFloat("12.3.4")` silently yields 12.3 and `parseFloat(".")` yields
    // NaN; strict whole-token parsing must reject any value that is not a single
    // well-formed decimal so corrupt docker output cannot pass as a real metric.
    const malformed = [
      line("12.3.4%", "128MiB / 512MiB", "0B / 0B", "0B / 0B"), // CPU partial token
      line("50.0%", "1.2.3MB / 512MiB", "0B / 0B", "0B / 0B"), // size partial token
      line("50.0%", ". / 512MiB", "0B / 0B", "0B / 0B"), // bare dot -> NaN
      line("50.0%", "12abc / 512MiB", "0B / 0B", "0B / 0B"), // trailing garbage
      line("1e3%", "128MiB / 512MiB", "0B / 0B", "0B / 0B"), // exponent form (not docker output)
      line("%12", "128MiB / 512MiB", "0B / 0B", "0B / 0B"), // misplaced percent
      line("12%3", "128MiB / 512MiB", "0B / 0B", "0B / 0B"), // embedded percent
      line("12.3", "128MiB / 512MiB", "0B / 0B", "0B / 0B"), // missing percent suffix
    ];
    for (const bad of malformed) {
      let err: unknown;
      try {
        parseDockerStats(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HetznerClientError);
      expect((err as HetznerClientError).code).toBe("invalid_input");
    }
  });

  it("throws invalid_input on a garbage size token", () => {
    let err: unknown;
    try {
      parseDockerStats(line("0.00%", "N/A / 512MiB", "0B / 0B", "0B / 0B"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HetznerClientError);
    expect((err as HetznerClientError).code).toBe("invalid_input");
  });
});
