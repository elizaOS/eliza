/**
 * Verifies dependency-aware LifeOps service startup through a real AgentRuntime
 * and PGlite while plugin services leave the shared init barrier concurrently.
 */

import { ScheduledTaskRunnerService } from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import {
  FAMILY_COMMUNICATIONS_SERVICE,
  FamilyCommunicationsRuntimeService,
} from "./family-communications/service.js";
import {
  FOOD_DOMAIN_SERVICE,
  FoodDomainRuntimeService,
} from "./food/service.js";
import {
  HOUSEHOLD_COORDINATION_SERVICE,
  HouseholdCoordinationRuntimeService,
} from "./household/service.js";
import {
  HOUSEHOLD_OPERATIONS_SERVICE,
  HouseholdOperationsRuntimeService,
} from "./household-operations/service.js";
import {
  SCHOOL_SOURCE_FACT_SERVICE,
  SchoolSourceFactRuntimeService,
} from "./school/service.js";

describe("LifeOps concurrent runtime-service startup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts every graph-dependent service once and keeps it registered", async () => {
    const runnerStart = vi.spyOn(ScheduledTaskRunnerService, "start");
    const householdStart = vi.spyOn(
      HouseholdCoordinationRuntimeService,
      "start",
    );
    const familyStart = vi.spyOn(FamilyCommunicationsRuntimeService, "start");
    const operationsStart = vi.spyOn(
      HouseholdOperationsRuntimeService,
      "start",
    );
    const schoolStart = vi.spyOn(SchoolSourceFactRuntimeService, "start");
    const foodStart = vi.spyOn(FoodDomainRuntimeService, "start");

    const runtimeResult = await createLifeOpsTestRuntime();
    try {
      const expectations = [
        {
          serviceType: ScheduledTaskRunnerService.serviceType,
          serviceClass: ScheduledTaskRunnerService,
          start: runnerStart,
        },
        {
          serviceType: HOUSEHOLD_COORDINATION_SERVICE,
          serviceClass: HouseholdCoordinationRuntimeService,
          start: householdStart,
        },
        {
          serviceType: FAMILY_COMMUNICATIONS_SERVICE,
          serviceClass: FamilyCommunicationsRuntimeService,
          start: familyStart,
        },
        {
          serviceType: HOUSEHOLD_OPERATIONS_SERVICE,
          serviceClass: HouseholdOperationsRuntimeService,
          start: operationsStart,
        },
        {
          serviceType: SCHOOL_SOURCE_FACT_SERVICE,
          serviceClass: SchoolSourceFactRuntimeService,
          start: schoolStart,
        },
        {
          serviceType: FOOD_DOMAIN_SERVICE,
          serviceClass: FoodDomainRuntimeService,
          start: foodStart,
        },
      ] as const;

      for (const expected of expectations) {
        expect(expected.start).toHaveBeenCalledTimes(1);
        expect(
          runtimeResult.runtime.getService(expected.serviceType),
        ).toBeInstanceOf(expected.serviceClass);
        expect(
          runtimeResult.runtime.getServiceRegistrationStatus(
            expected.serviceType,
          ),
        ).toBe("registered");
      }

      const loaded = await Promise.all(
        expectations.map((expected) =>
          runtimeResult.runtime.getServiceLoadPromise(expected.serviceType),
        ),
      );
      for (const [index, service] of loaded.entries()) {
        expect(service).toBe(
          runtimeResult.runtime.getService(
            expectations[index]?.serviceType ?? "",
          ),
        );
      }
    } finally {
      await runtimeResult.cleanup();
    }
  }, 180_000);
});
