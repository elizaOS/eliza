// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the primitive layer (components/ui/*).
 * Composes every primitive `*.stories.tsx` and renders it in jsdom, asserting it
 * mounts without throwing — the fast (jsdom) counterpart to the browser story
 * gate, covering every primitive story state and auto-covering new ones. See
 * `test/portable-stories.tsx`.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../*.stories.tsx", { eager: true });

smokeStoryModules("primitive", modules, { minModules: 20 });
