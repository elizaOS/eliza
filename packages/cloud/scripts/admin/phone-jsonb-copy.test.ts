/** Proves phone JSON copy parameters retain exact source lexemes and UTC dates. */

import { describe, expect, test } from "bun:test";
import {
  jsonbParameterPlaceholder,
  parsePgTimestampWithoutTimezoneUtc,
  phoneJsonAllowsNull,
  phoneJsonShape,
  prepareRawPhoneJson,
  rawJsonHasObjectTopLevel,
  rawJsonParameterValue,
} from "./phone-jsonb-copy";

describe("lossless phone JSONB copy", () => {
  test("enumerates all five phone JSON columns used by dry-run validation", () => {
    expect([
      [
        "agent_phone_numbers",
        "metadata",
        phoneJsonShape("agent_phone_numbers", "metadata"),
      ],
      [
        "phone_message_log",
        "media_urls",
        phoneJsonShape("phone_message_log", "media_urls"),
      ],
      [
        "phone_message_log",
        "metadata",
        phoneJsonShape("phone_message_log", "metadata"),
      ],
      [
        "agent_phone_contacts",
        "metadata",
        phoneJsonShape("agent_phone_contacts", "metadata"),
      ],
      [
        "phone_gateway_devices",
        "metadata",
        phoneJsonShape("phone_gateway_devices", "metadata"),
      ],
    ]).toEqual([
      ["agent_phone_numbers", "metadata", "object"],
      ["phone_message_log", "media_urls", "string_array"],
      ["phone_message_log", "metadata", "object"],
      ["agent_phone_contacts", "metadata", "object"],
      ["phone_gateway_devices", "metadata", "object"],
    ]);
    expect([
      phoneJsonAllowsNull("agent_phone_numbers", "metadata"),
      phoneJsonAllowsNull("phone_message_log", "media_urls"),
      phoneJsonAllowsNull("phone_message_log", "metadata"),
      phoneJsonAllowsNull("agent_phone_contacts", "metadata"),
      phoneJsonAllowsNull("phone_gateway_devices", "metadata"),
    ]).toEqual([true, true, true, false, false]);
  });

  test("rejects null metadata for both non-null phone JSON columns", () => {
    for (const table of ["agent_phone_contacts", "phone_gateway_devices"]) {
      expect(() =>
        prepareRawPhoneJson({ table, column: "metadata", value: null }),
      ).toThrow();
      try {
        prepareRawPhoneJson({ table, column: "metadata", value: null });
      } catch (error) {
        // error-policy:J3 the test inspects the typed invalid-input boundary.
        expect(error).toMatchObject({
          code: "PHONE_MIGRATION_JSON_INVALID",
          context: { table, column: "metadata", rule: "not_null" },
        });
      }
    }
  });

  test("distinguishes nullable SQL NULL from the JSON null lexeme", () => {
    for (const [table, column] of [
      ["agent_phone_numbers", "metadata"],
      ["phone_message_log", "media_urls"],
      ["phone_message_log", "metadata"],
    ] as const) {
      expect(prepareRawPhoneJson({ table, column, value: null })).toBeNull();
    }

    for (const [table, column] of [
      ["agent_phone_numbers", "metadata"],
      ["phone_message_log", "media_urls"],
      ["phone_message_log", "metadata"],
      ["agent_phone_contacts", "metadata"],
      ["phone_gateway_devices", "metadata"],
    ] as const) {
      expect(() =>
        prepareRawPhoneJson({ table, column, value: " \n null\t" }),
      ).toThrow();
      expect(() =>
        prepareRawPhoneJson({ table, column, value: "null" }),
      ).toThrow();
      try {
        prepareRawPhoneJson({ table, column, value: "null" });
      } catch (error) {
        // error-policy:J3 the test inspects the typed invalid-input boundary.
        expect(error).toMatchObject({
          code: "PHONE_MIGRATION_JSON_INVALID",
          context: { table, column, rule: "json_null" },
        });
      }
    }
  });

  test("binds large integers and long decimals exactly as source JSON text", () => {
    const raw =
      '{"large":900719925474099312345678901234567890,"decimal":0.123456789012345678901234567890}';
    const prepared = prepareRawPhoneJson({
      table: "agent_phone_numbers",
      column: "metadata",
      value: raw,
    });

    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error("Expected a prepared JSON parameter");
    expect(rawJsonParameterValue(prepared)).toBe(raw);
    const sql = `INSERT INTO phone_copy (metadata) VALUES (${jsonbParameterPlaceholder(1)})`;
    expect(sql).toBe("INSERT INTO phone_copy (metadata) VALUES ($1::jsonb)");
    expect([rawJsonParameterValue(prepared)]).toEqual([raw]);
  });

  test("retains PostgreSQL-valid numeric exponents beyond JavaScript range", () => {
    const raw = '{"huge":1e400,"tiny":1e-400,"nested":{"value":9e999}}';
    const prepared = prepareRawPhoneJson({
      table: "phone_gateway_devices",
      column: "metadata",
      value: raw,
    });

    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error("Expected a prepared JSON parameter");
    expect(rawJsonHasObjectTopLevel(prepared)).toBe(true);
    expect(rawJsonParameterValue(prepared)).toBe(raw);
    expect(jsonbParameterPlaceholder(3)).toBe("$3::jsonb");
  });

  test("throws a typed bounded error for malformed legacy JSON", () => {
    expect(() =>
      prepareRawPhoneJson({
        table: "phone_message_log",
        column: "metadata",
        value: '{"private":"SENTINEL",',
      }),
    ).toThrow();
    try {
      prepareRawPhoneJson({
        table: "phone_message_log",
        column: "metadata",
        value: '{"private":"SENTINEL",',
      });
    } catch (error) {
      // error-policy:J3 the test inspects the typed invalid-input boundary.
      expect(error).toMatchObject({ code: "PHONE_MIGRATION_JSON_INVALID" });
      expect(JSON.stringify(error)).not.toContain("SENTINEL");
    }
  });

  test("interprets Europe/Paris midnight-adjacent OID 1114 values as UTC", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Paris";
    try {
      expect(
        parsePgTimestampWithoutTimezoneUtc("2026-08-20 00:15:00").toISOString(),
      ).toBe("2026-08-20T00:15:00.000Z");
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
