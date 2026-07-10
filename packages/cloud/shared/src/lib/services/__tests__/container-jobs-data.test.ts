/** Exercises container-job runtime validation at its read and persistence boundaries. */
import { describe, expect, test } from "bun:test";
import {
  containerDeleteJobDataToRecord,
  containerLogsJobDataToRecord,
  containerProvisionJobDataToRecord,
  containerRestartJobDataToRecord,
  containerUpgradeJobDataToRecord,
  isContainerLogsJobData,
  isContainerProvisionJobData,
  isContainerUpgradeJobData,
  type JobLike,
  readContainerDeleteJobData,
  readContainerLogsJobData,
  readContainerProvisionJobData,
  readContainerRestartJobData,
  readContainerUpgradeJobData,
} from "../container-jobs-data";

const job = (data: unknown): JobLike => ({ id: "job-1", data });

describe("container-jobs-data codecs", () => {
  test("provision round-trips through toRecord -> read", () => {
    const data = { containerId: "c1", organizationId: "o1", userId: "u1" };
    const record = containerProvisionJobDataToRecord(data);
    expect(readContainerProvisionJobData(job(record))).toEqual(data);
  });

  test("delete + restart accept the minimal {containerId, organizationId}", () => {
    const data = { containerId: "c1", organizationId: "o1" };
    expect(readContainerDeleteJobData(job(containerDeleteJobDataToRecord(data)))).toEqual(data);
    expect(readContainerRestartJobData(job(data))).toEqual(data);
  });

  test("upgrade keeps an optional image, logs keeps an optional tail", () => {
    const up = { containerId: "c1", organizationId: "o1", image: "ghcr.io/x:2" };
    expect(readContainerUpgradeJobData(job(containerUpgradeJobDataToRecord(up)))).toEqual(up);
    const noImg = { containerId: "c1", organizationId: "o1" };
    expect(readContainerUpgradeJobData(job(noImg))).toEqual(noImg);

    const logs = { containerId: "c1", organizationId: "o1", tail: 200 };
    expect(readContainerLogsJobData(job(containerLogsJobDataToRecord(logs)))).toEqual(logs);
  });

  test("guards reject malformed data", () => {
    expect(isContainerProvisionJobData({ containerId: "c1", organizationId: "o1" })).toBe(false); // missing userId
    expect(isContainerProvisionJobData(null)).toBe(false);
    expect(
      isContainerProvisionJobData({ containerId: " ", organizationId: "o1", userId: "u1" }),
    ).toBe(false);
    expect(isContainerUpgradeJobData({ containerId: "c1", organizationId: "o1", image: 5 })).toBe(
      false,
    );
    expect(isContainerLogsJobData({ containerId: "c1", organizationId: "o1", tail: "200" })).toBe(
      false,
    );
  });

  test("read* throws (with the job id) on invalid data", () => {
    expect(() => readContainerProvisionJobData(job({ containerId: "c1" }))).toThrow("job-1");
    expect(() => readContainerLogsJobData(job("nope"))).toThrow();
  });

  test("persistence codecs reject missing runtime identifiers", () => {
    const deleteData = { containerId: "c1", organizationId: "o1" };
    Object.defineProperty(deleteData, "containerId", { value: undefined });
    expect(() => containerDeleteJobDataToRecord(deleteData)).toThrow("persistence");

    const provisionData = { containerId: "c1", organizationId: "o1", userId: "u1" };
    Object.defineProperty(provisionData, "userId", { value: undefined });
    expect(() => containerProvisionJobDataToRecord(provisionData)).toThrow("persistence");

    const restartData = { containerId: "c1", organizationId: "o1" };
    Object.defineProperty(restartData, "organizationId", { value: undefined });
    expect(() => containerRestartJobDataToRecord(restartData)).toThrow("persistence");

    const upgradeData = { containerId: "c1", organizationId: "o1", image: "image:2" };
    Object.defineProperty(upgradeData, "containerId", { value: undefined });
    expect(() => containerUpgradeJobDataToRecord(upgradeData)).toThrow("persistence");

    const logsData = { containerId: "c1", organizationId: "o1", tail: 100 };
    Object.defineProperty(logsData, "containerId", { value: undefined });
    expect(() => containerLogsJobDataToRecord(logsData)).toThrow("persistence");
  });
});
