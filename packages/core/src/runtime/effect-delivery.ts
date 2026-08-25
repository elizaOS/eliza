/**
 * Attaches non-serialized, core-owned grounding metadata to visible Content.
 * The enumerable symbol survives object spreads performed by sanitizers and
 * hooks, while JSON persistence and connector payloads ignore symbol keys. The
 * final callback boundary rechecks the exact text and receipt IDs so a later
 * transform cannot silently change a verified confirmation.
 */

import type { Content } from "../types/primitives";

const EFFECT_DELIVERY_BINDING = Symbol("@elizaos/core/effect-delivery-binding");
const AUTHENTIC_EFFECT_DELIVERY_BINDINGS = new WeakSet<object>();

interface EffectDeliveryBinding {
	text: string;
	receiptIds: readonly string[];
	applied: boolean;
}

type EffectBoundContent = Content & {
	[EFFECT_DELIVERY_BINDING]?: EffectDeliveryBinding;
};

/** Bind exact visible text to receipt IDs validated by the action runtime. */
export function bindEffectDelivery<T extends Content>(
	content: T,
	text: string,
	receiptIds: readonly string[],
	applied: boolean,
): T {
	const binding = Object.freeze({
		text: text.trim(),
		receiptIds: Object.freeze([...receiptIds]),
		applied,
	});
	AUTHENTIC_EFFECT_DELIVERY_BINDINGS.add(binding);
	return {
		...content,
		[EFFECT_DELIVERY_BINDING]: binding,
	} as T;
}

/** Read core-owned grounding metadata without exposing it in serialized content. */
export function getEffectDeliveryBinding(
	content: Content,
): EffectDeliveryBinding | undefined {
	const binding = (content as EffectBoundContent)[EFFECT_DELIVERY_BINDING];
	return binding && AUTHENTIC_EFFECT_DELIVERY_BINDINGS.has(binding)
		? binding
		: undefined;
}

/** True when neither hooks nor voice rewriting changed the bound confirmation. */
export function effectDeliveryBindingIsValid(content: Content): boolean {
	const binding = getEffectDeliveryBinding(content);
	if (!binding || content.text?.trim() !== binding.text) return false;
	const effectReceiptIds = content.effectReceiptIds;
	if (!Array.isArray(effectReceiptIds)) return false;
	if (effectReceiptIds.length !== binding.receiptIds.length) return false;
	return binding.receiptIds.every(
		(receiptId, index) => effectReceiptIds[index] === receiptId,
	);
}

/** True only when core bound this exact delivery to active applied receipts. */
export function effectDeliveryBindingProvesApplication(
	content: Content,
): boolean {
	const binding = getEffectDeliveryBinding(content);
	return (
		binding?.applied === true &&
		binding.receiptIds.length > 0 &&
		effectDeliveryBindingIsValid(content)
	);
}

/** Remove both serialized and core-owned proof markers before a safe fallback. */
export function stripEffectDeliveryBinding(content: Content): Content {
	const clone = { ...content } as EffectBoundContent;
	delete clone[EFFECT_DELIVERY_BINDING];
	delete clone.effectReceiptIds;
	return clone;
}
