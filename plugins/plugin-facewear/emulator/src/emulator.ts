/**
 * XR browser emulator — re-exported from the single canonical implementation in
 * `@elizaos/plugin-xr/simulator` (issue #9941: there must be exactly ONE XR
 * emulator/harness). This file used to be a byte-identical copy; it is now a
 * side-effect re-export so facewear's `dist/emulator.js` (served by
 * `routes/simulator-route.ts`) is built from the same source plugin-xr ships.
 *
 * Do not fork this. Extend the canonical emulator at
 * `plugins/plugin-xr/simulator/src/emulator.ts`.
 */
import "../../../plugin-xr/simulator/src/emulator.ts";
