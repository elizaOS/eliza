import { describe, expect, test } from "bun:test";
import {
  containerLogsJobDataToRecord,
  containerProvisionJobDataToRecord,
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
    expect(readContainerDeleteJobData(job(data))).toEqual(data);
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
});
