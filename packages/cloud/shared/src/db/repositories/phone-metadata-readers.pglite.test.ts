/** Proves every phone metadata reader keeps PostgreSQL JSONB numbers lossless. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import Decimal from "decimal.js";
import { drizzle } from "drizzle-orm/pglite";
import { isPhoneLosslessJsonNumber } from "../../lib/services/phone-lossless-json";
import { agentPhoneContacts } from "../schemas/agent-phone-contacts";
import { agentPhoneNumbers } from "../schemas/agent-phone-numbers";
import { phoneGatewayDevices } from "../schemas/phone-gateway-devices";
import {
  agentPhoneContactLosslessSelection,
  agentPhoneContactMetadataText,
  agentPhoneNumberLosslessSelection,
  agentPhoneNumberMetadataText,
  parseAgentPhoneContactMetadata,
  parseAgentPhoneNumberMetadata,
  parsePhoneGatewayDeviceMetadata,
  phoneGatewayDeviceLosslessSelection,
  phoneGatewayDeviceMetadataText,
} from "./phone-metadata-readers";

const EXTREME_METADATA = '{"huge":1e400,"tiny":1e-400,"rounded":9007199254740993,"ordinary":3.5}';

function rawNumberSource(value: unknown): string {
  expect(isPhoneLosslessJsonNumber(value)).toBe(true);
  return (value as { rawJSON: string }).rawJSON;
}

function expectExtremeNumbersRemainExact(metadata: Record<string, unknown>): void {
  expect(metadata.ordinary).toBe(3.5);
  expect(new Decimal(rawNumberSource(metadata.huge)).equals("1e400")).toBe(true);
  expect(new Decimal(rawNumberSource(metadata.tiny)).equals("1e-400")).toBe(true);
  expect(new Decimal(rawNumberSource(metadata.rounded)).equals("9007199254740993")).toBe(true);

  const serialized = JSON.stringify(metadata);
  expect(serialized).toContain('"rounded":9007199254740993');
  expect(serialized).not.toContain('"huge":null');
  expect(serialized).not.toContain('"tiny":0,');
  expect(serialized).not.toContain('"rounded":9007199254740992');
}

describe("phone metadata lossless SQL readers", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("casts all three JSONB columns to text before driver hydration and runtime validation", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE TABLE agent_phone_numbers (metadata jsonb);
      CREATE TABLE agent_phone_contacts (metadata jsonb NOT NULL);
      CREATE TABLE phone_gateway_devices (metadata jsonb NOT NULL);
    `);
    for (const table of ["agent_phone_numbers", "agent_phone_contacts", "phone_gateway_devices"]) {
      await database.query(`INSERT INTO ${table} (metadata) VALUES ($1::jsonb)`, [
        EXTREME_METADATA,
      ]);
    }

    const client = drizzle(database);
    for (const query of [
      client.select(agentPhoneNumberLosslessSelection).from(agentPhoneNumbers),
      client.select(agentPhoneContactLosslessSelection).from(agentPhoneContacts),
      client.select(phoneGatewayDeviceLosslessSelection).from(phoneGatewayDevices),
    ]) {
      const metadataProjection = query.toSQL().sql.match(/"metadata"::text/g);
      expect(metadataProjection).toHaveLength(1);
    }
    const [phoneNumberRow] = await client
      .select({ metadata: agentPhoneNumberMetadataText })
      .from(agentPhoneNumbers);
    const [contactRow] = await client
      .select({ metadata: agentPhoneContactMetadataText })
      .from(agentPhoneContacts);
    const [gatewayRow] = await client
      .select({ metadata: phoneGatewayDeviceMetadataText })
      .from(phoneGatewayDevices);

    expect(typeof phoneNumberRow?.metadata).toBe("string");
    expect(typeof contactRow?.metadata).toBe("string");
    expect(typeof gatewayRow?.metadata).toBe("string");

    const phoneNumberMetadata = parseAgentPhoneNumberMetadata(phoneNumberRow?.metadata ?? null);
    expect(phoneNumberMetadata).not.toBeNull();
    expectExtremeNumbersRemainExact(phoneNumberMetadata!);
    expectExtremeNumbersRemainExact(parseAgentPhoneContactMetadata(contactRow?.metadata ?? null));
    expectExtremeNumbersRemainExact(parsePhoneGatewayDeviceMetadata(gatewayRow?.metadata ?? null));
  });
});
