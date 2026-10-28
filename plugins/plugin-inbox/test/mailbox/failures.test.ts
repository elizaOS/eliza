/** Failure classification and disconnect read-back against closed fixtures. No network or account. */
import { describe, expect, it } from "vitest";
import {
  AttachmentRefusedError,
  attachmentReadFailure,
  attachmentRefused,
  classifyGmailFailure,
  disconnectGmailAccount,
  disconnectMessage,
  ManagedGmailProtocolError,
} from "../../src/mailbox/failures.ts";
import type { GmailAccount } from "../../src/mailbox/types.ts";

/** A host error class with the phone client's name. */
class CloudProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Cloud ${code}`);
    this.name = "CloudProtocolError";
  }
}
const signal = () => new AbortController().signal;

describe("managed Gmail failures", () => {
  it("classifies HTTP, transport and refusal failures for reads and operations", () => {
    for (const ErrorClass of [CloudProtocolError, ManagedGmailProtocolError]) {
      const http = (status: number) =>
        new (ErrorClass as typeof CloudProtocolError)("http", status);
      expect(classifyGmailFailure(http(409), "read", true).kind).toBe(
        "revoked",
      );
      expect(classifyGmailFailure(http(409), "operation", true).kind).toBe(
        "stale",
      );
      expect(classifyGmailFailure(http(403), "operation", true).kind).toBe(
        "revoked",
      );
      expect(classifyGmailFailure(http(404), "read", true).kind).toBe(
        "revoked",
      );
      expect(classifyGmailFailure(http(500), "read", true).kind).toBe(
        "unavailable",
      );
      expect(
        classifyGmailFailure(
          new (ErrorClass as typeof CloudProtocolError)("invalid-response"),
          "read",
          true,
        ).kind,
      ).toBe("unavailable");
      expect(classifyGmailFailure(http(500), "read", false).kind).toBe(
        "offline",
      );
    }
    expect(
      classifyGmailFailure(new TypeError("Failed to fetch"), "read", true).kind,
    ).toBe("offline");
    expect(
      classifyGmailFailure(new Error("Connection timed out"), "read", true)
        .kind,
    ).toBe("offline");
    expect(
      classifyGmailFailure(new TypeError("x is not a function"), "read", true)
        .kind,
    ).toBe("unavailable");
    const refusal = classifyGmailFailure(
      new AttachmentRefusedError(),
      "operation",
      false,
    );
    expect(refusal.kind).toBe("refused");
    expect(refusal.message).toMatch(/Nothing was sent or changed/);
    expect(
      classifyGmailFailure(
        new CloudProtocolError("http", 502),
        "operation",
        true,
      ).message,
    ).toMatch(/Check its receipt/);
  });

  it("treats an attachment's invalid response as a refusal of the file", () => {
    expect(
      attachmentRefused(
        attachmentReadFailure(new CloudProtocolError("invalid-response")),
      ),
    ).toBe(true);
    const other = new CloudProtocolError("http", 500);
    expect(attachmentReadFailure(other)).toBe(other);
    expect(attachmentRefused({ name: "AttachmentRefusedError" })).toBe(true);
  });

  it("requests a disconnect once and reports only what it read back", async () => {
    const rows = (connected: boolean): GmailAccount[] => [
      {
        connectionId: "grant",
        label: "Mailbox",
        configured: true,
        connected,
        reason: "",
        grantedCapabilities: connected ? ["google.gmail.triage"] : [],
      },
    ];
    const client = ({
      fail = false,
      after = false,
      readFails = false,
    } = {}) => {
      const calls = { disconnect: 0, reads: 0 };
      return {
        calls,
        async disconnectGmail() {
          calls.disconnect++;
          if (fail) throw new CloudProtocolError("http", 502);
        },
        async gmailAccounts() {
          calls.reads++;
          if (readFails) throw new TypeError("Failed to fetch");
          return rows(after);
        },
      };
    };
    const cases: Array<[Parameters<typeof client>[0], string]> = [
      [{}, "disconnected"],
      [{ after: true }, "still-connected"],
      [{ readFails: true }, "unconfirmed"],
      [{ fail: true, after: true }, "unconfirmed"],
      [{ fail: true }, "disconnected"],
      [{ fail: true, readFails: true }, "unconfirmed"],
    ];
    for (const [options, outcome] of cases) {
      const fixture = client(options);
      expect(
        (await disconnectGmailAccount(fixture, "grant", signal())).outcome,
      ).toBe(outcome);
      expect(fixture.calls.disconnect).toBe(1);
    }
    expect(disconnectMessage("disconnected", "Mailbox")).toMatch(
      /No mail was deleted/,
    );
    expect(disconnectMessage("unconfirmed", "Mailbox")).toMatch(
      /not confirmed/,
    );
  });
});
