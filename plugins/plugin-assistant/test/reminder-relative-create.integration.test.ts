/** Real SQL approval creation; no model, device, approval decision or scheduler call. */
import { randomUUID } from "node:crypto";
import {
  type ActionParameters,
  type ActionResult,
  type Memory,
  validateToolArgs,
} from "@elizaos/core";
import { expect, test, vi } from "vitest";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../src/services/device-actions/action.ts";
import {
  validateDeviceOperation,
  validateDevicePayload,
} from "../src/services/device-actions/contract.ts";
import {
  DeviceActionService,
  getDeviceActionTurn,
  withDeviceActionTurn,
} from "../src/services/device-actions/service.ts";

const operation = {
  type: "reminder_create_after",
  fields: {
    title: "Stretch",
    body: "Exact requested body",
    schedule: { after: "2m", alertMinutes: 0 },
  },
};
const message = {
  createdAt: 1,
  content: { text: "Untrusted text is not parsed", metadata: { timestamp: 1 } },
} as unknown as Memory;

test("relative reminder uses one authenticated turn anchor and reuses its canonical SQL approval on retry", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "RelativeReminderFixture",
  });
  const service = new DeviceActionService(runtime);
  const credential = {
    subjectUserId: randomUUID(),
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: ["reminders.create.v1"],
  };
  try {
    await service.register(credential, "Relative reminder fixture");
    const parameters = {
      operation,
      operationKey: randomUUID(),
      reason: "Owner requested one reminder in two minutes",
    };
    const call = (p: ActionParameters = parameters) =>
      proposeDeviceAction.handler(runtime, message, undefined, {
        parameters: p,
      });
    await expect(call()).rejects.toThrow("No authenticated phone");
    const scoped = deviceActionForCapabilities(
      proposeDeviceAction,
      credential.capabilities,
    );
    expect(validateToolArgs(scoped, parameters).valid).toBe(true);
    expect(
      validateToolArgs(
        deviceActionForCapabilities(proposeDeviceAction, []),
        parameters,
      ).valid,
    ).toBe(false);
    expect(() => validateDeviceOperation(operation)).toThrow();
    let clock = Date.now();
    const anchor = clock;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await withDeviceActionTurn(runtime, credential, async () => {
        expect(getDeviceActionTurn()?.startedAt).toBe(anchor);
        clock += 35_000;
        const first = (await call()) as ActionResult;
        expect(first.data).toMatchObject({
          executed: false,
          approvalRequired: true,
          reminderTiming: {
            dueAt: new Date(anchor + 120_000).toISOString(),
            alertAt: new Date(anchor + 120_000).toISOString(),
          },
        });
        expect(
          first.effectReceipts?.every((r) => r.outcome === "preview"),
        ).toBe(true);
        clock += 15_000;
        const retry = (await call()) as ActionResult;
        expect(retry.data?.proposalId).toBe(first.data?.proposalId);
        expect(retry.data?.reminderTiming).toEqual(first.data?.reminderTiming);
        const rows = await service.list(credential);
        expect(rows).toHaveLength(1);
        expect(validateDevicePayload(rows[0].payload).operation).toEqual({
          type: "reminder_create",
          fields: {
            ...operation.fields,
            schedule: {
              at: anchor + 120_000,
              dueAt: anchor + 120_000,
              alertMinutes: 0,
              recurrence: null,
            },
          },
        });
        expect(rows[0].state).toBe("pending");
        expect(rows[0].execution).toBeNull();
        for (const after of [
          "",
          "-2m",
          "NaN",
          "Infinity",
          "2",
          "0m",
          "0.1ms",
          "9007199254740992d",
          "8640000000000000ms",
          "1ms",
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ]) {
          await expect(
            call({
              ...parameters,
              operationKey: randomUUID(),
              operation: {
                ...operation,
                fields: {
                  ...operation.fields,
                  schedule: { after, alertMinutes: 0 },
                },
              },
            }),
          ).rejects.toThrow();
        }
        const invalidSchedules: ActionParameters[] = [
          { after: "2m", alertMinutes: -1 },
          { after: "2m", alertMinutes: 3 },
          { after: "2m", alertMinutes: 0, recurrence: null },
          { after: "2m", alertMinutes: 0, startedAt: 1 },
        ];
        for (const schedule of invalidSchedules)
          await expect(
            call({
              ...parameters,
              operationKey: randomUUID(),
              operation: {
                ...operation,
                fields: { ...operation.fields, schedule },
              },
            }),
          ).rejects.toThrow();
        expect(await service.list(credential)).toHaveLength(1);
        const noAlert = (await call({
          ...parameters,
          operationKey: randomUUID(),
          operation: {
            ...operation,
            fields: {
              ...operation.fields,
              schedule: { after: "2m", alertMinutes: null },
            },
          },
        })) as ActionResult;
        expect(noAlert.data?.reminderTiming).toEqual({
          dueAt: new Date(anchor + 120_000).toISOString(),
          alertAt: null,
        });
        expect(noAlert.data?.approvalRequired).toBe(true);
        for (const recurrence of [
          null,
          {
            rule: "daily",
            zone: "UTC",
            date: "2026-10-09",
            time: "09:00",
            leadMinutes: 0,
          },
        ]) {
          const absolute = {
            type: "reminder_create",
            fields: {
              title: "Absolute fixture",
              body: "Keep native contract",
              schedule: {
                at: anchor + 3_600_000,
                dueAt: anchor + 3_600_000,
                alertMinutes: 0,
                recurrence,
              },
            },
          };
          const result = (await call({
            ...parameters,
            operation: absolute,
            operationKey: randomUUID(),
          })) as ActionResult;
          const saved = (await service.list(credential)).find(
            (row) => row.id === result.data?.proposalId,
          );
          expect(saved).toBeDefined();
          expect(validateDevicePayload(saved?.payload).operation).toEqual(
            absolute,
          );
        }
      });
    } finally {
      spy.mockRestore();
    }
    await withDeviceActionTurn(
      runtime,
      { ...credential, capabilities: [] },
      async () => {
        await expect(call()).rejects.toThrow("capability");
      },
    );
  } finally {
    await cleanup();
  }
}, 120_000);
