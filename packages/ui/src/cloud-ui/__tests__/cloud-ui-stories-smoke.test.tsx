// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the cloud-ui component set (@elizaos/ui/cloud-ui).
 * Composes every cloud-ui `*.stories.tsx` and renders it in jsdom, asserting it
 * mounts without throwing. See `test/portable-stories.tsx`.
 */
import { smokeStoryModules } from "../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("cloud-ui", modules, { minModules: 10 });
