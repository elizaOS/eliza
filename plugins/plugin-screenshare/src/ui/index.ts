import { registerOperatorSurface } from "@elizaos/app-core";
import { ScreenshareOperatorSurface } from "./ScreenshareOperatorSurface";

registerOperatorSurface("@elizaos/plugin-screenshare", ScreenshareOperatorSurface);

export { ScreenshareOperatorSurface };
