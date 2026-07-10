// Exercises app container store behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { toNewContainer } from "../app-container-record";
import {
  mapContainerRowToAppContainerRow,
  mergeHostPlacementMetadata,
  type ProjectableContainerRow,
} from "../app-container-store";

const DSN = "postgresql://app_x:pw@cluster:5432/db_app_x?sslmode=require";

function row(overrides: Partial<ProjectableContainerRow> = {}): ProjectableContainerRow {
  return {
    id: "c-1",
    name: "app-abc",
    project_name: "app-id-123",
    image_tag: "ghcr.io/elizaos/app-x:latest",
    port: 3000,
    organization_id: "org-1",
    user_id: "user-1",
    environment_vars: { DATABASE_URL: DSN, PORT: "3000" },
    metadata: {},
    node_id: null,
    ...overrides,
  };
}

describe("mapContainerRowToAppContainerRow", () => {
  test("projects columns and carries the per-tenant DSN through env vars", () => {
    const r = mapContainerRowToAppContainerRow(
      row({ metadata: { hostContainerId: "docker-immutable-1" } }),
    );
    expect(r).toEqual({
      id: "c-1",
      appId: "app-id-123", // from project_name (no metadata.appId)
      containerName: "app-abc",
      image: "ghcr.io/elizaos/app-x:latest",
      port: 3000,
      organizationId: "org-1",
      userId: "user-1",
      environmentVars: { DATABASE_URL: DSN, PORT: "3000" },
      hostContainerId: "docker-immutable-1",
    });
  });

  test("prefers metadata.appId over project_name when present", () => {
    expect(mapContainerRowToAppContainerRow(row({ metadata: { appId: "meta-app" } })).appId).toBe(
      "meta-app",
    );
  });

  test("null image_tag becomes empty string", () => {
    expect(mapContainerRowToAppContainerRow(row({ image_tag: null })).image).toBe("");
  });
});

describe("mergeHostPlacementMetadata", () => {
  const info = { hostContainerId: "h-9", hostPort: 21000, network: "app-net-x" };

  test("preserves existing metadata (e.g. appId) and adds host placement", () => {
    expect(mergeHostPlacementMetadata({ appId: "a1", foo: 1 }, info)).toEqual({
      appId: "a1",
      foo: 1,
      hostContainerId: "h-9",
      hostPort: 21000,
      network: "app-net-x",
    });
  });

  test("null/undefined existing → just the host placement", () => {
    expect(mergeHostPlacementMetadata(null, info)).toEqual(info);
    expect(mergeHostPlacementMetadata(undefined, info)).toEqual(info);
  });
});

describe("toNewContainer", () => {
  test("the app's OWN DSN rides in environment_vars; project_name + metadata key off appId", () => {
    const nc = toNewContainer({
      appId: "app-id-123",
      organizationId: "org-1",
      userId: "user-1",
      containerName: "app-abc",
      image: "ghcr.io/elizaos/app-x:latest",
      port: 3000,
      environmentVars: { DATABASE_URL: DSN },
    });
    expect(nc.environment_vars).toEqual({ DATABASE_URL: DSN });
    expect(nc.project_name).toBe("app-id-123");
    expect(nc.metadata).toEqual({ appId: "app-id-123" });
    expect(nc.status).toBe("pending");
    expect(nc.image_tag).toBe("ghcr.io/elizaos/app-x:latest");
  });
});
