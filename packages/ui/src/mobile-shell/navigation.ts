/**
 * Shell navigation: the open view, the views Back returns to and the All apps
 * drawer. The host closes its own layers (dialogs, chat sheets, voice) before
 * it dispatches Back here, and runs each view's leave/enter work itself.
 */
export interface MobileShellNavigation {
  /** Open view key; null is Home. */
  view: string | null;
  /** Views Back returns to, oldest first. */
  stack: readonly string[];
  /** All apps drawer over Home. */
  drawer: boolean;
  drawerQuery: string;
}

export type MobileShellNavigationAction =
  | {
      type: "open";
      view: string;
      /** push: Back returns to the current, different view; keep: leave the stack; reset (default): clear it. */
      history?: "push" | "keep" | "reset";
      /** Leave the drawer and its query as they are. */
      keepDrawer?: boolean;
    }
  | { type: "home" }
  | { type: "back" }
  | { type: "drawer"; open: boolean }
  | { type: "drawer-query"; query: string };

export const MOBILE_SHELL_STACK_LIMIT = 6;

export const MOBILE_SHELL_HOME: MobileShellNavigation = Object.freeze({
  view: null,
  stack: Object.freeze([]) as readonly string[],
  drawer: false,
  drawerQuery: "",
});

export function navigateMobileShell(
  state: MobileShellNavigation,
  action: MobileShellNavigationAction,
): MobileShellNavigation {
  switch (action.type) {
    case "open": {
      const history = action.history ?? "reset";
      // Pushing needs a different view to return to; otherwise it starts over.
      const stack =
        history === "keep"
          ? state.stack
          : history === "push" && state.view && state.view !== action.view
            ? [...state.stack, state.view].slice(-MOBILE_SHELL_STACK_LIMIT)
            : [];
      return action.keepDrawer
        ? { ...state, view: action.view, stack }
        : { view: action.view, stack, drawer: false, drawerQuery: "" };
    }
    case "home":
      return MOBILE_SHELL_HOME;
    case "back": {
      if (state.view === null)
        return state.drawer
          ? { ...state, drawer: false, drawerQuery: "" }
          : state;
      const previous = state.stack.at(-1);
      return previous === undefined
        ? MOBILE_SHELL_HOME
        : { ...state, view: previous, stack: state.stack.slice(0, -1) };
    }
    case "drawer":
      return { ...state, drawer: action.open, drawerQuery: "" };
    case "drawer-query":
      return state.drawer ? { ...state, drawerQuery: action.query } : state;
  }
}
