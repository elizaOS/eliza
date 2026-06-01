/**
 * Covers the autoscaler's safer defaults:
 *   - defaultHcloudServerType bumped cpx32 → ccx33 so the out-of-the-box pair
 *     with the 8-agents/node default capacity gives ~4 GB/agent (cpx32 was
 *     ~1 GB/agent under the same capacity and got OOM-killed in prod). ccx33
 *     was picked over a same-sized shared type (cpx51) because Hetzner's API
 *     rejects cpx51 creation in fsn1/nbg1/hel1 in practice.
 *   - defaultAutoscaleNodeCapacity is env-overridable (CONTAINERS_AUTOSCALE_
 *     NODE_CAPACITY) so ops can right-size a smaller server type without a
 *     code change. Clamped to [1, 64]; falls back to 8 on garbage/missing.
 */
import { describe, expect, test } from "bun:test";
import { containersEnv } from "../../config/containers-env";
import { runWithCloudBindings } from "../../runtime/cloud-bindings";

const CAP = "CONTAINERS_AUTOSCALE_NODE_CAPACITY";
const PRIMARY = "CONTAINERS_HCLOUD_SERVER_TYPE";
const LEGACY = "HCLOUD_SERVER_TYPE";
const AUTOSCALE_ENV_KEYS = [CAP, PRIMARY, LEGACY] as const;

const EMPTY_AUTOSCALE_ENV = {
  [CAP]: "",
  [PRIMARY]: "",
  [LEGACY]: "",
} satisfies Record<string, string>;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = original;
}

function withAutoscaleEnv(env: Record<string, string>, fn: () => void): void {
  const bindings = { ...EMPTY_AUTOSCALE_ENV, ...env };
  const original = Object.fromEntries(
    AUTOSCALE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof AUTOSCALE_ENV_KEYS)[number], string | undefined>;

  for (const key of AUTOSCALE_ENV_KEYS) {
    process.env[key] = bindings[key];
  }

  try {
    runWithCloudBindings(bindings, fn);
  } finally {
    for (const key of AUTOSCALE_ENV_KEYS) {
      restoreEnv(key, original[key]);
    }
  }
}

describe("defaultHcloudServerType", () => {
  test("falls back to ccx33 (32 GB amd64, dedicated vCPU) when no env is set", () => {
    withAutoscaleEnv({}, () => {
      expect(containersEnv.defaultHcloudServerType()).toBe("ccx33");
    });
  });

  test("primary env wins over legacy alias", () => {
    withAutoscaleEnv({ [PRIMARY]: "ccx33", [LEGACY]: "cpx41" }, () => {
      expect(containersEnv.defaultHcloudServerType()).toBe("ccx33");
    });
  });

  test("honors legacy HCLOUD_SERVER_TYPE if only it is set", () => {
    withAutoscaleEnv({ [LEGACY]: "cpx41" }, () => {
      expect(containersEnv.defaultHcloudServerType()).toBe("cpx41");
    });
  });
});

describe("defaultAutoscaleNodeCapacity", () => {
  test("defaults to 8 when env is unset", () => {
    withAutoscaleEnv({}, () => {
      expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(8);
    });
  });

  test("reads a valid positive integer from env", () => {
    withAutoscaleEnv({ [CAP]: "4" }, () => {
      expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(4);
    });
  });

  test("floors fractional values", () => {
    withAutoscaleEnv({ [CAP]: "5.9" }, () => {
      expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(5);
    });
  });

  test("clamps an oversized value to 64", () => {
    withAutoscaleEnv({ [CAP]: "999" }, () => {
      expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(64);
    });
  });

  test("falls back to 8 on zero, negative, or non-numeric", () => {
    for (const raw of ["0", "-1", "abc", ""]) {
      withAutoscaleEnv({ [CAP]: raw }, () => {
        expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(8);
      });
    }
  });
});
