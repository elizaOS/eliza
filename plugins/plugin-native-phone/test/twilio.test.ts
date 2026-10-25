import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sendTwilioSms } from "../src/twilio";

const credentials = {
  accountSid: "ACtest",
  authToken: "token",
  fromPhoneNumber: "+15550000000",
};

let bodies: string[] = [];
let rejectFromCall: number | undefined;
let server: ReturnType<typeof Bun.serve>;
let savedBase: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const form = new URLSearchParams(await request.text());
      bodies.push(form.get("Body") ?? "");
      if (rejectFromCall !== undefined && bodies.length >= rejectFromCall) {
        return Response.json(
          { code: 21610, message: "rejected" },
          { status: 400 },
        );
      }
      return Response.json({ sid: `SM${bodies.length}` }, { status: 201 });
    },
  });
  savedBase = process.env.ELIZA_MOCK_TWILIO_BASE;
  process.env.ELIZA_MOCK_TWILIO_BASE = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  if (savedBase === undefined) delete process.env.ELIZA_MOCK_TWILIO_BASE;
  else process.env.ELIZA_MOCK_TWILIO_BASE = savedBase;
});

beforeEach(() => {
  bodies = [];
  rejectFromCall = undefined;
});

describe("sendTwilioSms", () => {
  test("a body over the 1600-character limit is sent as ordered parts", async () => {
    const body = "a".repeat(2000);

    const result = await sendTwilioSms({
      credentials,
      to: "+15551234567",
      body,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies.every((part) => part.length <= 1600)).toBe(true);
    expect(bodies.join("")).toBe(body);
    expect(result.ok).toBe(true);
    expect(result.sid).toBe("SM1");
    expect(result.sids).toEqual(["SM1", "SM2"]);
    expect(result.billing?.segments).toBe(13);
  });

  test("a body with spaces and line breaks keeps every character across parts", async () => {
    const body = Array.from({ length: 400 }, (_, i) => `w${i}`)
      .join(" ")
      .replace(/w(\d*0) /g, "w$1\n")
      .slice(0, 1750);

    await sendTwilioSms({ credentials, to: "+15551234567", body });

    expect(bodies).toHaveLength(2);
    expect(bodies.every((part) => part.length <= 1600)).toBe(true);
    expect(bodies.join("")).toBe(body);
  });

  test("a space at the start of a part is not sent as its own message", async () => {
    const body = `${"a".repeat(1600)} ${"b".repeat(1600)}`;

    await sendTwilioSms({ credentials, to: "+15551234567", body });

    expect(bodies.map((part) => part.length)).toEqual([1600, 1600, 1]);
    expect(bodies.join("")).toBe(body);
  });

  test.each([
    ["space", " "],
    ["newline", "\n"],
  ])(
    "a long body that ends with a %s does not send a blank message",
    async (_name, tail) => {
      const result = await sendTwilioSms({
        credentials,
        to: "+15551234567",
        body: `${"a".repeat(1600)}${tail}`,
      });

      expect(bodies).toEqual(["a".repeat(1600)]);
      expect(result.ok).toBe(true);
      expect(result.sids).toEqual(["SM1"]);
      expect(result.billing?.segments).toBe(10);
    },
  );

  test("a run of whitespace longer than one part is not sent as a blank message", async () => {
    const body = `${"a".repeat(1599)}${" ".repeat(1700)}b`;

    await sendTwilioSms({ credentials, to: "+15551234567", body });

    expect(bodies.every((part) => part.trim().length > 0)).toBe(true);
    expect(bodies.join("").replace(/ /g, "")).toBe(`${"a".repeat(1599)}b`);
  });

  test("a short body is sent as one message", async () => {
    const result = await sendTwilioSms({
      credentials,
      to: "+15551234567",
      body: "hello",
    });

    expect(bodies).toEqual(["hello"]);
    expect(result.ok).toBe(true);
    expect(result.sid).toBe("SM1");
    expect(result.billing?.segments).toBe(1);
  });

  test("a rejection after an accepted part is reported as unknown, not rejected", async () => {
    rejectFromCall = 2;

    const result = await sendTwilioSms({
      credentials,
      to: "+15551234567",
      body: "a".repeat(3500),
    });

    expect(bodies).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.sids).toEqual(["SM1"]);
  });

  test("a rejection of the first part stays a rejection", async () => {
    rejectFromCall = 1;

    const result = await sendTwilioSms({
      credentials,
      to: "+15551234567",
      body: "a".repeat(3500),
    });

    expect(bodies).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});
