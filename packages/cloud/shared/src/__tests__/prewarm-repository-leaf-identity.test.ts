/** Canonical service leaves must retain the exact repository instances and prototypes. */
import { describe, expect, test } from "bun:test";
import * as barrel from "../db/repositories";
import { ApiKeysRepository, apiKeysRepository } from "../db/repositories/api-keys";
import { AppsRepository, appsRepository } from "../db/repositories/apps";
import {
  CreditTransactionsRepository,
  creditTransactionsRepository,
} from "../db/repositories/credit-transactions";
import { GenerationsRepository, generationsRepository } from "../db/repositories/generations";
import { OrganizationsRepository, organizationsRepository } from "../db/repositories/organizations";
import { UsageRecordsRepository, usageRecordsRepository } from "../db/repositories/usage-records";
import { UserSessionsRepository, userSessionsRepository } from "../db/repositories/user-sessions";

describe("prewarm canonical repository identity", () => {
  for (const [name, instance, constructor] of [
    ["apiKeysRepository", apiKeysRepository, ApiKeysRepository],
    ["appsRepository", appsRepository, AppsRepository],
    ["creditTransactionsRepository", creditTransactionsRepository, CreditTransactionsRepository],
    ["generationsRepository", generationsRepository, GenerationsRepository],
    ["organizationsRepository", organizationsRepository, OrganizationsRepository],
    ["usageRecordsRepository", usageRecordsRepository, UsageRecordsRepository],
    ["userSessionsRepository", userSessionsRepository, UserSessionsRepository],
  ] as const) {
    test(`${name} keeps singleton identity and its original method implementation`, () => {
      const original = barrel[name];
      expect(instance).toBe(original);
      expect(Object.getPrototypeOf(instance)).toBe(constructor.prototype);
    });
  }
});
