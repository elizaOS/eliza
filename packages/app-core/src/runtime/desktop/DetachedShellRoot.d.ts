import { type WindowShellRoute } from "@elizaos/ui/platform/window-shell";
import { type JSX } from "react";

interface DetachedShellRootProps {
  route: Exclude<
    WindowShellRoute,
    | {
        mode: "main";
      }
    | {
        mode: "pill";
      }
  >;
}
export declare function DetachedShellRoot({
  route,
}: DetachedShellRootProps): JSX.Element;
//# sourceMappingURL=DetachedShellRoot.d.ts.map
