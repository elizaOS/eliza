/**
 * Type-seam coverage for the notification triage model (spec §C.1): the
 * priority→tier mapping and the category→priority producer defaults. These are
 * pure functions with no runtime dependency, so they live next to the types.
 */
import { describe, expect, it } from "vitest";
import {
	defaultPriorityForCategory,
	type NotificationCategory,
	type NotificationPriority,
	type NotificationTier,
	SILENT_TIER_DEFAULT_EXPIRY_MS,
	tierForPriority,
} from "./notification.ts";

describe("notification triage model (§C.1)", () => {
	describe("tierForPriority", () => {
		it("maps urgent/high to the interrupt tier", () => {
			expect(tierForPriority("urgent")).toBe<NotificationTier>("interrupt");
			expect(tierForPriority("high")).toBe<NotificationTier>("interrupt");
		});

		it("maps normal to the digest tier", () => {
			expect(tierForPriority("normal")).toBe<NotificationTier>("digest");
		});

		it("maps low to the silent tier", () => {
			expect(tierForPriority("low")).toBe<NotificationTier>("silent");
		});

		it("covers every priority", () => {
			const priorities: NotificationPriority[] = [
				"low",
				"normal",
				"high",
				"urgent",
			];
			const tiers = new Set<NotificationTier>([
				"interrupt",
				"digest",
				"silent",
			]);
			for (const p of priorities) {
				expect(tiers.has(tierForPriority(p))).toBe(true);
			}
		});
	});

	describe("defaultPriorityForCategory", () => {
		it("defaults approval to an interrupt-tier priority", () => {
			expect(tierForPriority(defaultPriorityForCategory("approval"))).toBe(
				"interrupt",
			);
		});

		it("defaults task/workflow to the digest tier", () => {
			expect(tierForPriority(defaultPriorityForCategory("task"))).toBe(
				"digest",
			);
			expect(tierForPriority(defaultPriorityForCategory("workflow"))).toBe(
				"digest",
			);
		});

		it("defaults routine system to the silent tier", () => {
			expect(tierForPriority(defaultPriorityForCategory("system"))).toBe(
				"silent",
			);
		});

		it("returns a valid priority for every category", () => {
			const categories: NotificationCategory[] = [
				"reminder",
				"task",
				"workflow",
				"agent",
				"approval",
				"message",
				"health",
				"system",
				"general",
			];
			const valid = new Set<NotificationPriority>([
				"low",
				"normal",
				"high",
				"urgent",
			]);
			for (const c of categories) {
				expect(valid.has(defaultPriorityForCategory(c))).toBe(true);
			}
		});
	});

	it("exposes a 24h silent-tier default expiry window", () => {
		expect(SILENT_TIER_DEFAULT_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
	});
});
