/**
 * The `navigationChanged` payload type: Android carries the `getSurfaceState` fields,
 * iOS only the surface identity, so every state field must stay optional and a listener
 * must still accept the identity-only event.
 */
import { describe, expectTypeOf, it } from "vitest";
import type {
  ElizaSurfaceManagerPlugin,
  NavigationChangedEvent,
  SurfaceIdOptions,
  SurfaceState,
} from "./definitions";

describe("NavigationChangedEvent", () => {
  it("accepts the identity-only event iOS sends", () => {
    const ios = { id: "tab", owner: "app", session: "s", epoch: 1 };
    expectTypeOf(ios).toMatchTypeOf<NavigationChangedEvent>();
    expectTypeOf<SurfaceIdOptions>().toMatchTypeOf<NavigationChangedEvent>();
  });

  it("keeps every state field optional and typed as getSurfaceState returns it", () => {
    expectTypeOf<NavigationChangedEvent["currentUrl"]>().toEqualTypeOf<
      SurfaceState["currentUrl"] | undefined
    >();
    expectTypeOf<NavigationChangedEvent["exists"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<NavigationChangedEvent["title"]>().toEqualTypeOf<
      SurfaceState["title"]
    >();
    expectTypeOf<NavigationChangedEvent["owner"]>().toEqualTypeOf<string>();
  });

  it("is what a navigationChanged listener receives, without a non-null URL", () => {
    // Never called: it only has to compile against the plugin's listener overload.
    const subscribe = (plugin: ElizaSurfaceManagerPlugin) =>
      plugin.addListener("navigationChanged", (event) => {
        expectTypeOf(event).toEqualTypeOf<NavigationChangedEvent>();
        // @ts-expect-error iOS sends no currentUrl, so it can be undefined.
        const url: string | null = event.currentUrl;
        return url;
      });
    expectTypeOf(subscribe).toBeFunction();
  });
});
