import { describe, expect, it } from "vitest";
import { actionToJsonSchema } from "../../actions/action-schema";
import {
	MESSAGE_PARAMETERS,
	messageAction,
} from "../../features/advanced-capabilities/actions/message";
import { characterAction } from "../../features/advanced-capabilities/personality/actions/character";
import { manageMessageAction } from "../../features/messaging/triage/actions/manageMessage";
import { MANAGE_OPERATION_KINDS } from "../../features/messaging/triage/types";
import { paymentAction } from "../../features/payments/actions/payment";
import {
	PAYMENT_CONTEXT_KINDS,
	PAYMENT_CONTEXT_SCOPES,
} from "../../features/payments/types";
import type { Action, ActionParameter } from "../../types/components";
import { CANONICAL_MESSAGE_TARGET_KINDS } from "../../types/runtime";

type EnumExpectation = {
	param: string;
	expected: readonly string[];
	path?: ReadonlyArray<string | number>;
};

function findParam(
	params: readonly ActionParameter[],
	name: string,
): ActionParameter {
	const p = params.find((x) => x.name === name);
	if (!p) throw new Error(`param ${name} not found`);
	return p;
}

function readEnum(
	schema: unknown,
	path: ReadonlyArray<string | number>,
): readonly unknown[] | undefined {
	let cursor: unknown = schema;
	for (const step of path) {
		if (cursor == null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[String(step)];
	}
	if (cursor == null || typeof cursor !== "object") return undefined;
	const enumValue = (cursor as { enum?: unknown }).enum;
	return Array.isArray(enumValue) ? enumValue : undefined;
}

function assertEnumOnParam(
	action: Action | { parameters: readonly ActionParameter[] },
	expectation: EnumExpectation,
): void {
	const param = findParam(action.parameters ?? [], expectation.param);
	const schemaPath = expectation.path ?? [];
	const onParam = readEnum(param.schema, schemaPath);
	expect(onParam, `${expectation.param} schema enum missing`).toBeDefined();
	expect([...(onParam ?? [])].sort()).toEqual([...expectation.expected].sort());
}

function assertEnumOnJsonSchema(
	action: Action,
	expectation: EnumExpectation,
): void {
	const json = actionToJsonSchema(action) as {
		properties?: Record<string, unknown>;
	};
	const props = json.properties ?? {};
	const propPath = [
		"properties",
		expectation.param,
		...(expectation.path ?? []),
	];
	const lifted: Record<string, unknown> = { properties: props };
	const enumValue = readEnum(lifted, propPath);
	expect(
		enumValue,
		`${expectation.param} JSON schema enum missing`,
	).toBeDefined();
	expect([...(enumValue ?? [])].sort()).toEqual(
		[...expectation.expected].sort(),
	);
}

describe("action schema enum coverage", () => {
	describe("MESSAGE_PARAMETERS (advanced messaging)", () => {
		it("targetKind is constrained to canonical message target kinds", () => {
			assertEnumOnParam(
				{ parameters: MESSAGE_PARAMETERS },
				{
					param: "targetKind",
					expected: CANONICAL_MESSAGE_TARGET_KINDS,
				},
			);
			assertEnumOnJsonSchema(messageAction, {
				param: "targetKind",
				expected: CANONICAL_MESSAGE_TARGET_KINDS,
			});
		});

		it("manageOperation is constrained to manage-operation kinds", () => {
			assertEnumOnParam(
				{ parameters: MESSAGE_PARAMETERS },
				{ param: "manageOperation", expected: MANAGE_OPERATION_KINDS },
			);
			assertEnumOnJsonSchema(messageAction, {
				param: "manageOperation",
				expected: MANAGE_OPERATION_KINDS,
			});
		});
	});

	describe("manageMessageAction", () => {
		it("operation is constrained to manage-operation kinds", () => {
			assertEnumOnParam(manageMessageAction, {
				param: "operation",
				expected: MANAGE_OPERATION_KINDS,
			});
			assertEnumOnJsonSchema(manageMessageAction, {
				param: "operation",
				expected: MANAGE_OPERATION_KINDS,
			});
		});
	});

	describe("paymentAction", () => {
		it("paymentContext.kind is constrained to payment-context kinds", () => {
			assertEnumOnParam(paymentAction, {
				param: "paymentContext",
				expected: PAYMENT_CONTEXT_KINDS,
				path: ["properties", "kind"],
			});
			assertEnumOnJsonSchema(paymentAction, {
				param: "paymentContext",
				expected: PAYMENT_CONTEXT_KINDS,
				path: ["properties", "kind"],
			});
		});

		it("paymentContext.scope is constrained to payment-context scopes", () => {
			assertEnumOnParam(paymentAction, {
				param: "paymentContext",
				expected: PAYMENT_CONTEXT_SCOPES,
				path: ["properties", "scope"],
			});
			assertEnumOnJsonSchema(paymentAction, {
				param: "paymentContext",
				expected: PAYMENT_CONTEXT_SCOPES,
				path: ["properties", "scope"],
			});
		});
	});

	describe("characterAction", () => {
		it("fieldsToSave array items are constrained to saveable character fields", () => {
			const param = findParam(characterAction.parameters ?? [], "fieldsToSave");
			const itemsEnum = readEnum(param.schema, ["items"]);
			expect(itemsEnum).toBeDefined();
			expect((itemsEnum ?? []).length).toBeGreaterThan(0);
			expect((itemsEnum ?? []).every((v) => typeof v === "string")).toBe(true);

			const json = actionToJsonSchema(characterAction) as {
				properties?: Record<string, { items?: { enum?: unknown[] } }>;
			};
			const liftedEnum = json.properties?.fieldsToSave?.items?.enum;
			expect(Array.isArray(liftedEnum)).toBe(true);
			expect((liftedEnum ?? []).length).toBeGreaterThan(0);
		});
	});
});
