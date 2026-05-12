import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readVastManifest } from "../../../scripts/vast/manifest";
import {
  buildEndpointJobPayload,
  buildWorkergroupPayload,
} from "../../../scripts/vast/provision-endpoint";

const ENV_KEYS = [
  "VAST_ENDPOINT_NAME",
  "VAST_MIN_LOAD",
  "VAST_TARGET_UTIL",
  "VAST_COLD_MULT",
  "VAST_COLD_WORKERS",
  "VAST_MAX_WORKERS",
  "VAST_GPU_RAM_GB",
  "VAST_SEARCH_PARAMS",
] as const;

let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  saved = {} as typeof saved;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("Vast provisioning payloads", () => {
  test("builds endpoint and workergroup payloads from the 27B manifest", () => {
    const manifest = readVastManifest("eliza-1-27b.json").manifest;
    const endpoint = buildEndpointJobPayload(manifest);
    const workergroup = buildWorkergroupPayload(123, endpoint, manifest, 456);

    expect(endpoint.endpoint_name).toBe("eliza-cloud-eliza-1-27b");
    expect(endpoint.cold_workers).toBe(1);
    expect(endpoint.max_workers).toBe(8);
    expect(workergroup).toMatchObject({
      endpoint_id: 456,
      template_id: 123,
      gpu_ram: 176,
    });
    expect(workergroup.search_params).toContain("gpu_name in [B200_SXM,H200_SXM,H200_NVL]");
    expect(workergroup.search_params).toContain("num_gpus>=2");
    expect(workergroup.search_params).toContain("gpu_ram>=180000");
  });

  test("env overrides scale and search controls without mutating the manifest", () => {
    process.env.VAST_ENDPOINT_NAME = "custom-eliza";
    process.env.VAST_MAX_WORKERS = "3";
    process.env.VAST_GPU_RAM_GB = "96";
    process.env.VAST_SEARCH_PARAMS = "gpu_name=H100_SXM gpu_ram>=90000";

    const manifest = readVastManifest("eliza-1-9b.json").manifest;
    const endpoint = buildEndpointJobPayload(manifest);
    const workergroup = buildWorkergroupPayload(222, endpoint, manifest);

    expect(endpoint.endpoint_name).toBe("custom-eliza");
    expect(endpoint.max_workers).toBe(3);
    expect(workergroup.endpoint_name).toBe("custom-eliza");
    expect(workergroup.gpu_ram).toBe(96);
    expect(workergroup.search_params).toBe("gpu_name=H100_SXM gpu_ram>=90000");
  });
});
