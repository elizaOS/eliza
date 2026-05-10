/**
 * Basic Providers
 *
 * Core providers included by default in the basic-capabilities plugin.
 */

export { actionStateProvider } from "./actionState.ts";
export { actionsProvider } from "./actions.ts";
export { attachmentsProvider } from "./attachments.ts";
export { characterProvider } from "./character.ts";
export { choiceProvider } from "./choice.ts";
export { contextBenchProvider } from "./contextBench.ts";
export { currentTimeProvider } from "./currentTime.ts";
export { entitiesProvider } from "./entities.ts";
export {
	PLATFORM_CHAT_CONTEXT_PROVIDER_NAME,
	PLATFORM_USER_CONTEXT_PROVIDER_NAME,
	platformChatContextProvider,
	platformUserContextProvider,
} from "./platformContext.ts";
export { providersProvider } from "./providers.ts";
export { recentMessagesProvider } from "./recentMessages.ts";
export { uiContextProvider } from "./uiContext.ts";
export { worldProvider } from "./world.ts";

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { actionStateProvider as _bs_1_actionStateProvider } from "./actionState.ts";
import { actionsProvider as _bs_2_actionsProvider } from "./actions.ts";
import { attachmentsProvider as _bs_3_attachmentsProvider } from "./attachments.ts";
import { characterProvider as _bs_4_characterProvider } from "./character.ts";
import { choiceProvider as _bs_5_choiceProvider } from "./choice.ts";
import { contextBenchProvider as _bs_6_contextBenchProvider } from "./contextBench.ts";
import { currentTimeProvider as _bs_7_currentTimeProvider } from "./currentTime.ts";
import { entitiesProvider as _bs_8_entitiesProvider } from "./entities.ts";
import { PLATFORM_CHAT_CONTEXT_PROVIDER_NAME as _bs_9_PLATFORM_CHAT_CONTEXT_PROVIDER_NAME, PLATFORM_USER_CONTEXT_PROVIDER_NAME as _bs_10_PLATFORM_USER_CONTEXT_PROVIDER_NAME, platformChatContextProvider as _bs_11_platformChatContextProvider, platformUserContextProvider as _bs_12_platformUserContextProvider } from "./platformContext.ts";
import { providersProvider as _bs_13_providersProvider } from "./providers.ts";
import { recentMessagesProvider as _bs_14_recentMessagesProvider } from "./recentMessages.ts";
import { uiContextProvider as _bs_15_uiContextProvider } from "./uiContext.ts";
import { worldProvider as _bs_16_worldProvider } from "./world.ts";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_BASIC_CAPABILITIES_PROVIDERS_INDEX__ = [_bs_1_actionStateProvider, _bs_2_actionsProvider, _bs_3_attachmentsProvider, _bs_4_characterProvider, _bs_5_choiceProvider, _bs_6_contextBenchProvider, _bs_7_currentTimeProvider, _bs_8_entitiesProvider, _bs_9_PLATFORM_CHAT_CONTEXT_PROVIDER_NAME, _bs_10_PLATFORM_USER_CONTEXT_PROVIDER_NAME, _bs_11_platformChatContextProvider, _bs_12_platformUserContextProvider, _bs_13_providersProvider, _bs_14_recentMessagesProvider, _bs_15_uiContextProvider, _bs_16_worldProvider];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_FEATURES_BASIC_CAPABILITIES_PROVIDERS_INDEX__ = __bundle_safety_FEATURES_BASIC_CAPABILITIES_PROVIDERS_INDEX__;
