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
  for (const [name, instance, constructor, original] of [
    ["apiKeysRepository", apiKeysRepository, ApiKeysRepository, barrel.apiKeysRepository],
    ["appsRepository", appsRepository, AppsRepository, barrel.appsRepository],
    [
      "creditTransactionsRepository",
      creditTransactionsRepository,
      CreditTransactionsRepository,
      barrel.creditTransactionsRepository,
    ],
    [
      "generationsRepository",
      generationsRepository,
      GenerationsRepository,
      barrel.generationsRepository,
    ],
    [
      "organizationsRepository",
      organizationsRepository,
      OrganizationsRepository,
      barrel.organizationsRepository,
    ],
    [
      "usageRecordsRepository",
      usageRecordsRepository,
      UsageRecordsRepository,
      barrel.usageRecordsRepository,
    ],
    [
      "userSessionsRepository",
      userSessionsRepository,
      UserSessionsRepository,
      barrel.userSessionsRepository,
    ],
  ] as const) {
    test(`${name} keeps singleton identity and its original method implementation`, () => {
      expect(instance).toBe(original);
      expect(Object.getPrototypeOf(instance)).toBe(constructor.prototype);
    });
  }
});
