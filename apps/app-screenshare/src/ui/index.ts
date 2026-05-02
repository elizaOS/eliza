import { registerOperatorSurface } from "@elizaos/app-core/components/apps/surfaces/registry";
import { ScreenshareOperatorSurface } from "./ScreenshareOperatorSurface";

registerOperatorSurface("@elizaos/app-screenshare", ScreenshareOperatorSurface);

export { ScreenshareOperatorSurface };
