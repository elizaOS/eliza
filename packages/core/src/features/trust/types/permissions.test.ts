/**
 * Covers the trust capability's Unix-style permission helpers: octal mode
 * parsing and the owner/group/other execute/read/write bit evaluation that
 * `ContextualPermissionSystem` and the service wrappers rely on. The
 * load-bearing branches are caller classification (self, owner-UUID match,
 * admin, trusted-with-sufficient-trust, role members, everyone else) and
 * which of the three 3-bit groups each classification reads. Pure
 * deterministic unit harness against the real module; no mocks.
 */
import { describe, expect, it } from "vitest";
import { PermissionUtils } from "./permissions.ts";

const OWNER = "11111111-2222-4333-8444-555555555555";

describe("fromOctal", () => {
	it("parses octal mode strings into numeric modes", () => {
		expect(PermissionUtils.fromOctal("755")).toBe(0o755);
		expect(PermissionUtils.fromOctal("644")).toBe(0o644);
		expect(PermissionUtils.fromOctal("700")).toBe(0o700);
		expect(PermissionUtils.fromOctal("000")).toBe(0);
	});

	it("accepts four-digit strings including special bits", () => {
		expect(PermissionUtils.fromOctal("4755")).toBe(0o4755);
		expect(PermissionUtils.fromOctal("1777")).toBe(0o1777);
	});
});

describe("canExecute", () => {
	it("grants self but denies admin and others on an owner-only mode", () => {
		const permission = { mode: 0o700, owner: OWNER };
		const exec = (caller: string) =>
			PermissionUtils.canExecute(permission, { caller });
		expect(exec("self")).toBe(true);
		expect(exec("admin")).toBe(false);
		expect(exec("anon")).toBe(false);
	});

	it("treats a caller whose id equals the owner as the owner", () => {
		const permission = { mode: 0o700, owner: OWNER };
		expect(PermissionUtils.canExecute(permission, { caller: OWNER })).toBe(
			true,
		);
		expect(
			PermissionUtils.canExecute(permission, {
				caller: "99999999-9999-4999-8999-999999999999",
			}),
		).toBe(false);
	});

	it("lets anonymous callers through only when the other bits allow execution", () => {
		const world = { mode: 0o755, owner: OWNER };
		const closed = { mode: 0o750, owner: OWNER };
		expect(PermissionUtils.canExecute(world, { caller: "anon" })).toBe(true);
		expect(PermissionUtils.canExecute(closed, { caller: "anon" })).toBe(false);
	});

	it("classifies role members into the group bits", () => {
		const permission = {
			mode: 0o750,
			owner: OWNER,
			group: "maintainers",
		};
		const member = { caller: "user-a", roles: ["maintainers"] };
		const outsider = { caller: "user-b", roles: [] };
		expect(PermissionUtils.canExecute(permission, member)).toBe(true);
		expect(PermissionUtils.canExecute(permission, outsider)).toBe(false);
	});

	it("admits trusted callers at a trust score of 80 and rejects just below", () => {
		const permission = {
			mode: 0o750,
			owner: OWNER,
			group: "trusted",
		};
		expect(
			PermissionUtils.canExecute(permission, { caller: "user-a", trust: 80 }),
		).toBe(true);
		expect(
			PermissionUtils.canExecute(permission, { caller: "user-a", trust: 79 }),
		).toBe(false);
	});

	it("ignores setuid-style special bits when evaluating execution", () => {
		const permission = { mode: 0o4700, owner: OWNER };
		expect(PermissionUtils.canExecute(permission, { caller: "self" })).toBe(
			true,
		);
		expect(PermissionUtils.canExecute(permission, { caller: "admin" })).toBe(
			false,
		);
	});
});

describe("canRead", () => {
	it("keeps an owner-only mode private against every other class", () => {
		const permission = { mode: 0o400, owner: OWNER };
		expect(PermissionUtils.canRead(permission, { caller: "self" })).toBe(true);
		expect(PermissionUtils.canRead(permission, { caller: "admin" })).toBe(
			false,
		);
		expect(PermissionUtils.canRead(permission, { caller: "anon" })).toBe(false);
	});

	it("reads the other-class read bit for unclassified callers", () => {
		const permission = { mode: 0o644, owner: OWNER };
		expect(PermissionUtils.canRead(permission, { caller: "anon" })).toBe(true);
	});
});

describe("canWrite", () => {
	it("grants writes to self alone on 0200", () => {
		const permission = { mode: 0o200, owner: OWNER };
		expect(PermissionUtils.canWrite(permission, { caller: "self" })).toBe(true);
		expect(PermissionUtils.canWrite(permission, { caller: "admin" })).toBe(
			false,
		);
		expect(PermissionUtils.canWrite(permission, { caller: "anon" })).toBe(
			false,
		);
	});

	it("separates the read and write bits for anonymous callers on 0644", () => {
		const permission = { mode: 0o644, owner: OWNER };
		expect(PermissionUtils.canWrite(permission, { caller: "anon" })).toBe(
			false,
		);
		expect(PermissionUtils.canRead(permission, { caller: "anon" })).toBe(true);
	});

	it("grants group-classified writers exactly the group write bit", () => {
		const permission = {
			mode: 0o775,
			owner: OWNER,
			group: "editors",
		};
		const member = { caller: "user-a", roles: ["editors"] };
		const reader = { caller: "user-b" };
		expect(PermissionUtils.canWrite(permission, member)).toBe(true);
		expect(PermissionUtils.canWrite(permission, reader)).toBe(false);
		expect(PermissionUtils.canExecute(permission, reader)).toBe(true);
	});

	it("evaluates admin through the group bits even when the group is custom", () => {
		const permission = {
			mode: 0o730,
			owner: OWNER,
			group: "maintainers",
		};
		expect(PermissionUtils.canWrite(permission, { caller: "admin" })).toBe(
			true,
		);
		expect(PermissionUtils.canExecute(permission, { caller: "admin" })).toBe(
			true,
		);
		expect(PermissionUtils.canRead(permission, { caller: "admin" })).toBe(
			false,
		);
	});
});
