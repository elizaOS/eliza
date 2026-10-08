/** Canonical service leaves must retain the exact repository instances and prototypes. */
import { describe, expect, test } from "bun:test";
import * as barrel from "../db/repositories";
import {
  apiKeysRepository,
  ApiKeysRepository,
} from "../db/repositories/api-keys";
import { appsRepository, AppsRepository } from "../db/repositories/apps";
import {
  creditPacksRepository,
  CreditPacksRepository,
} from "../db/repositories/credit-packs";
import {
  creditTransactionsRepository,
  CreditTransactionsRepository,
} from "../db/repositories/credit-transactions";
import {
  generationsRepository,
  GenerationsRepository,
} from "../db/repositories/generations";
import {
  organizationsRepository,
  OrganizationsRepository,
} from "../db/repositories/organizations";
import {
  usageRecordsRepository,
  UsageRecordsRepository,
} from "../db/repositories/usage-records";
import {
  userSessionsRepository,
  UserSessionsRepository,
} from "../db/repositories/user-sessions";

describe("prewarm canonical repository identity", () => {
  for (const [name, instance, constructor] of [
    ["apiKeysRepository", apiKeysRepository, ApiKeysRepository],
    ["appsRepository", appsRepository, AppsRepository],
    ["creditPacksRepository", creditPacksRepository, CreditPacksRepository],
    [
      "creditTransactionsRepository",
      creditTransactionsRepository,
      CreditTransactionsRepository,
    ],
    ["generationsRepository", generationsRepository, GenerationsRepository],
    [
      "organizationsRepository",
      organizationsRepository,
      OrganizationsRepository,
    ],
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
