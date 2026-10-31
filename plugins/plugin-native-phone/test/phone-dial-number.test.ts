import { beforeEach, describe, expect, mock, test } from "bun:test";
// The workspace source of the contract, so this test does not depend on an
// installed or built copy of @elizaos/contracts.
import * as telephony from "../../../packages/contracts/src/native-telephony.ts";

mock.module("@elizaos/contracts/native-telephony", () => telephony);
const placeCall = mock(async (_: { number: string }) => {});
const openDialer = mock(async (_?: { number: string }) => {});
mock.module("@elizaos/plugin-native-phone/bridge", () => ({
  Phone: { placeCall, openDialer },
}));

const { registerTelephonyProfile } = await import("../src/telephony-profile");
const { interact } = await import("../src/components/phone-interact");
const { normalizeNumber } = await import(
  "../src/components/phone-view-helpers"
);

describe("Phone number entry", () => {
  beforeEach(() => {
    placeCall.mockClear();
    openDialer.mockClear();
    registerTelephonyProfile(null);
  });

  test("removes only whitespace and visual separators", () => {
    expect(normalizeNumber(" +1 (555) 123-4567 ")).toBe("+15551234567");
    expect(normalizeNumber("555.123.4567")).toBe("5551234567");
    expect(normalizeNumber("030/1234567")).toBe("0301234567");
  });

  test("keeps the keypad's * and # and the dial pauses in the number", () => {
    expect(normalizeNumber("*67 555 123 4567")).toBe("*675551234567");
    expect(normalizeNumber("*86")).toBe("*86");
    expect(normalizeNumber("+1 555-012-3456#12")).toBe("+15550123456#12");
    expect(normalizeNumber("+1 555-123-4567,,89")).toBe("+15551234567,,89");
    expect(normalizeNumber("+1 555-123-4567;89")).toBe("+15551234567;89");
  });

  test("refuses a letter instead of joining the digits around it", () => {
    expect(normalizeNumber("1-800-FLOWERS")).toBe("");
    expect(normalizeNumber("555-123-4567 ext. 89")).toBe("");
    expect(normalizeNumber("+1 555 123 4567 +")).toBe("");
  });

  test("calls a contact number with its extension pause, not a longer number", async () => {
    expect(
      await interact("place-call", { number: "+1 555-123-4567,,89" }),
    ).toEqual({ placed: true, number: "+15551234567,,89" });
    expect(placeCall).toHaveBeenCalledTimes(1);
    expect(placeCall).toHaveBeenCalledWith({ number: "+15551234567,,89" });
  });

  test("opens the system dialer with the complete number", async () => {
    expect(
      await interact("open-dialer", { number: "+1 555-012-3456#12" }),
    ).toEqual({ opened: true, number: "+15550123456#12" });
    expect(openDialer).toHaveBeenCalledWith({ number: "+15550123456#12" });
  });

  test("does not call the digits of a number written with letters", async () => {
    await expect(
      interact("place-call", { number: "1-800-FLOWERS" }),
    ).rejects.toThrow("number is not a dialable phone number");
    await expect(interact("place-call", { number: " " })).rejects.toThrow(
      "number is required",
    );
    expect(placeCall).not.toHaveBeenCalled();
  });

  test("behind the profile a code prefix stays refused by the shared rule", async () => {
    const dial = mock(async (_: { number: string }) => ({
      status: "handed-off",
      target: "dialer",
      handler: "example.host",
      message: "Review the number and press Call.",
    }));
    const clear = registerTelephonyProfile(
      telephony.createTelephonyClient({ dial } as never, true),
    );
    try {
      await expect(
        interact("place-call", { number: "*67 555 123 4567" }),
      ).rejects.toThrow("Not a dialable phone number");
      await expect(
        interact("open-dialer", { number: "+1 555-123-4567,,89" }),
      ).rejects.toThrow("Not a dialable phone number");
      expect(
        await interact("place-call", { number: "+1 (555) 123-4567" }),
      ).toEqual({
        placed: false,
        handoff: "handed-off",
        handler: "example.host",
        number: "+15551234567",
      });
    } finally {
      clear();
    }
    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledWith({ number: "+15551234567" });
    expect(placeCall).not.toHaveBeenCalled();
  });
});
