import type { PermissionOverwrites, Role } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  diffOverwrites,
  diffRolePermissions,
  ELEVATED_PERMISSIONS,
  hasElevatedPermissions,
  isElevatedRole,
} from "../permissionEvents";

// Mock types for testing that match Discord.js interfaces
interface MockPermissionOverwrites {
  allow: { toArray: () => string[] };
  deny: { toArray: () => string[] };
  type: number;
}

interface MockRole {
  permissions: {
    has: (perm: string) => boolean;
    toArray: () => string[];
  };
}

function createMockOverwrite(
  allow: string[] = [],
  deny: string[] = [],
  type: number = 0
): MockPermissionOverwrites {
  return {
    allow: { toArray: () => allow },
    deny: { toArray: () => deny },
    type,
  };
}

function createMockRole(permissions: string[]): MockRole {
  return {
    permissions: {
      has: (perm: string) => permissions.includes(perm),
      toArray: () => permissions,
    },
  };
}

describe("ELEVATED_PERMISSIONS", () => {
  it("contains expected elevated permissions", () => {
    expect(ELEVATED_PERMISSIONS).toContain("Administrator");
    expect(ELEVATED_PERMISSIONS).toContain("ManageRoles");
    expect(ELEVATED_PERMISSIONS).toContain("ManageChannels");
    expect(ELEVATED_PERMISSIONS).toContain("KickMembers");
    expect(ELEVATED_PERMISSIONS).toContain("BanMembers");
  });

  it("does not contain non-elevated permissions", () => {
    expect(ELEVATED_PERMISSIONS).not.toContain("SendMessages");
    expect(ELEVATED_PERMISSIONS).not.toContain("ViewChannel");
    expect(ELEVATED_PERMISSIONS).not.toContain("ReadMessageHistory");
  });
});

describe("hasElevatedPermissions", () => {
  it("returns true for Administrator", () => {
    expect(hasElevatedPermissions(["Administrator"])).toBe(true);
  });

  it("returns true for ManageRoles", () => {
    expect(hasElevatedPermissions(["ManageRoles"])).toBe(true);
  });

  it("returns true when mixed with non-elevated permissions", () => {
    expect(hasElevatedPermissions(["SendMessages", "BanMembers", "ViewChannel"])).toBe(true);
  });

  it("returns false for non-elevated permissions only", () => {
    expect(hasElevatedPermissions(["SendMessages", "ViewChannel"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasElevatedPermissions([])).toBe(false);
  });
});

describe("isElevatedRole", () => {
  it("returns true for role with Administrator", () => {
    const role = createMockRole(["Administrator"]);
    // MockRole satisfies the Role interface requirements for this function
    expect(isElevatedRole(role as Role)).toBe(true);
  });

  it("returns true for role with ManageMessages", () => {
    const role = createMockRole(["ManageMessages"]);
    // MockRole satisfies the Role interface requirements for this function
    expect(isElevatedRole(role as Role)).toBe(true);
  });

  it("returns false for role without elevated permissions", () => {
    const role = createMockRole(["SendMessages", "ViewChannel"]);
    // MockRole satisfies the Role interface requirements for this function
    expect(isElevatedRole(role as Role)).toBe(false);
  });
});

describe("diffOverwrites", () => {
  it("returns CREATE action when old is null", () => {
    const newOw = createMockOverwrite(["SendMessages"], ["ManageMessages"]);
    const result = diffOverwrites(null, newOw as unknown as PermissionOverwrites);

    expect(result.action).toBe("CREATE");
    expect(result.changes).toHaveLength(2);
    expect(result.changes).toContainEqual({
      permission: "SendMessages",
      oldState: "NEUTRAL",
      newState: "ALLOW",
    });
    expect(result.changes).toContainEqual({
      permission: "ManageMessages",
      oldState: "NEUTRAL",
      newState: "DENY",
    });
  });

  it("returns DELETE action when new is null", () => {
    const oldOw = createMockOverwrite(["SendMessages"], ["ManageMessages"]);
    const result = diffOverwrites(oldOw as unknown as PermissionOverwrites, null);

    expect(result.action).toBe("DELETE");
    expect(result.changes).toHaveLength(2);
    expect(result.changes).toContainEqual({
      permission: "SendMessages",
      oldState: "ALLOW",
      newState: "NEUTRAL",
    });
    expect(result.changes).toContainEqual({
      permission: "ManageMessages",
      oldState: "DENY",
      newState: "NEUTRAL",
    });
  });

  it("detects ALLOW → DENY changes", () => {
    const oldOw = createMockOverwrite(["ManageMessages"], []);
    const newOw = createMockOverwrite([], ["ManageMessages"]);
    const result = diffOverwrites(
      oldOw as unknown as PermissionOverwrites,
      newOw as unknown as PermissionOverwrites
    );

    expect(result.action).toBe("UPDATE");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      permission: "ManageMessages",
      oldState: "ALLOW",
      newState: "DENY",
    });
  });

  it("detects DENY → NEUTRAL changes", () => {
    const oldOw = createMockOverwrite([], ["ManageMessages"]);
    const newOw = createMockOverwrite([], []);
    const result = diffOverwrites(
      oldOw as unknown as PermissionOverwrites,
      newOw as unknown as PermissionOverwrites
    );

    expect(result.action).toBe("UPDATE");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      permission: "ManageMessages",
      oldState: "DENY",
      newState: "NEUTRAL",
    });
  });

  it("returns empty changes for identical overwrites", () => {
    const oldOw = createMockOverwrite(["SendMessages"], ["ManageMessages"]);
    const newOw = createMockOverwrite(["SendMessages"], ["ManageMessages"]);
    const result = diffOverwrites(
      oldOw as unknown as PermissionOverwrites,
      newOw as unknown as PermissionOverwrites
    );

    expect(result.action).toBe("UPDATE");
    expect(result.changes).toHaveLength(0);
  });

  it("returns empty changes when both are null", () => {
    const result = diffOverwrites(null, null);

    expect(result.action).toBe("UPDATE");
    expect(result.changes).toHaveLength(0);
  });
});

describe("diffRolePermissions", () => {
  it("detects added permissions", () => {
    const oldRole = createMockRole(["SendMessages"]);
    const newRole = createMockRole(["SendMessages", "ManageMessages"]);
    // MockRole satisfies the Role interface requirements for this function
    const result = diffRolePermissions(oldRole as Role, newRole as Role);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      permission: "ManageMessages",
      oldState: "NEUTRAL",
      newState: "ALLOW",
    });
  });

  it("detects removed permissions", () => {
    const oldRole = createMockRole(["SendMessages", "ManageMessages"]);
    const newRole = createMockRole(["SendMessages"]);
    // MockRole satisfies the Role interface requirements for this function
    const result = diffRolePermissions(oldRole as Role, newRole as Role);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      permission: "ManageMessages",
      oldState: "ALLOW",
      newState: "NEUTRAL",
    });
  });

  it("detects both added and removed permissions", () => {
    const oldRole = createMockRole(["SendMessages", "ManageMessages"]);
    const newRole = createMockRole(["SendMessages", "KickMembers"]);
    // MockRole satisfies the Role interface requirements for this function
    const result = diffRolePermissions(oldRole as Role, newRole as Role);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      permission: "KickMembers",
      oldState: "NEUTRAL",
      newState: "ALLOW",
    });
    expect(result).toContainEqual({
      permission: "ManageMessages",
      oldState: "ALLOW",
      newState: "NEUTRAL",
    });
  });

  it("returns empty for identical permissions", () => {
    const oldRole = createMockRole(["SendMessages", "ManageMessages"]);
    const newRole = createMockRole(["SendMessages", "ManageMessages"]);
    // MockRole satisfies the Role interface requirements for this function
    const result = diffRolePermissions(oldRole as Role, newRole as Role);

    expect(result).toHaveLength(0);
  });
});
