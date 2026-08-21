/** Pins the five semantic phone JSON columns and their database shape constraints. */

import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { agentPhoneContacts } from "./agent-phone-contacts";
import { agentPhoneNumbers, phoneMessageLog } from "./agent-phone-numbers";
import { phoneGatewayDevices } from "./phone-gateway-devices";

function columnType(table: Parameters<typeof getTableConfig>[0], columnName: string): string {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`Missing column ${columnName}`);
  return column.getSQLType();
}

describe("phone JSONB schema authority", () => {
  test("declares all five semantic JSON columns as jsonb", () => {
    expect(columnType(agentPhoneNumbers, "metadata")).toBe("jsonb");
    expect(columnType(phoneMessageLog, "media_urls")).toBe("jsonb");
    expect(columnType(phoneMessageLog, "metadata")).toBe("jsonb");
    expect(columnType(agentPhoneContacts, "metadata")).toBe("jsonb");
    expect(columnType(phoneGatewayDevices, "metadata")).toBe("jsonb");
  });

  test("stores the immutable tenant owner on each message log", () => {
    const messageConfig = getTableConfig(phoneMessageLog);
    const owner = messageConfig.columns.find(({ name }) => name === "organization_id");
    expect(owner?.getSQLType()).toBe("uuid");
    expect(owner?.notNull).toBe(true);
    expect(messageConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      "phone_message_log_phone_owner_fk",
    );
    expect(messageConfig.indexes.map(({ config }) => config.name)).toContain(
      "phone_message_log_organization_idx",
    );
    expect(getTableConfig(agentPhoneNumbers).indexes.map(({ config }) => config.name)).toContain(
      "agent_phone_numbers_id_organization_idx",
    );
  });

  test("retains named object/array checks as migration parity targets", () => {
    expect(getTableConfig(agentPhoneNumbers).checks.map(({ name }) => name)).toContain(
      "agent_phone_numbers_metadata_object_check",
    );
    expect(getTableConfig(phoneMessageLog).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "phone_message_log_media_urls_array_check",
        "phone_message_log_metadata_object_check",
      ]),
    );
    expect(getTableConfig(agentPhoneContacts).checks.map(({ name }) => name)).toContain(
      "agent_phone_contacts_metadata_object_check",
    );
    expect(getTableConfig(phoneGatewayDevices).checks.map(({ name }) => name)).toContain(
      "phone_gateway_devices_metadata_object_check",
    );

    const mediaCheck = getTableConfig(phoneMessageLog).checks.find(
      ({ name }) => name === "phone_message_log_media_urls_array_check",
    );
    if (!mediaCheck) throw new Error("Missing media_urls array check");
    expect(new PgDialect().sqlToQuery(mediaCheck.value).sql).toContain("strict $[*]");
  });
});
