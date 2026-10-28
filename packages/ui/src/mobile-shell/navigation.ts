/**
 * Shell navigation: the open view, the views Back returns to, the All apps
 * drawer and the assistant's detent over them (a pill, the composer, a half
 * sheet or the full conversation). The host closes its own layers (dialogs,
 * voice, a view's inner pages) before it dispatches Back here, and runs each
 * view's leave/enter work itself.
 */

/** Where the assistant sits over the shell. */
export type MobileAssistantDetent = "pill" | "input" | "sheet" | "full";
/** A detent a surface rests in while the conversation is closed. */
export type MobileAssistantRest = "pill" | "input";

export interface MobileShellNavigation {
  /** Open view key; null is Home. */
  view: string | null;
  /** Views Back returns to, oldest first. */
  stack: readonly string[];
  /** All apps drawer over Home. */
  drawer: boolean;
  drawerQuery: string;
  /** The assistant's detent; Home rests in the composer. */
  assistant: MobileAssistantDetent;
}

export type MobileShellNavigationAction =
  | {
      type: "open";
      view: string;
      /** push: Back returns to the current, different view; keep: leave the stack; reset (default): clear it. */
      history?: "push" | "keep" | "reset";
      /** Leave the drawer and its query as they are. */
      keepDrawer?: boolean;
      /** Detent to open the view in; its rest detent by default. */
      assistant?: MobileAssistantDetent;
    }
  | {
      type: "home";
      /** Detent to show Home in; the composer by default. */
      assistant?: MobileAssistantDetent;
    }
  | { type: "back" }
  | { type: "drawer"; open: boolean }
  | { type: "drawer-query"; query: string }
  /** Move the assistant; `rest` returns it to the open surface's rest detent. */
  | { type: "assistant"; detent: MobileAssistantDetent | "rest" };

export interface MobileShellNavigationOptions {
  /** Rest detent of an open view; the pill when absent. */
  assistantRest?: (view: string) => MobileAssistantRest;
}

export const MOBILE_SHELL_STACK_LIMIT = 6;

export const MOBILE_SHELL_HOME: MobileShellNavigation = Object.freeze({
  view: null,
  stack: Object.freeze([]) as readonly string[],
  drawer: false,
  drawerQuery: "",
  assistant: "input",
});

/** The detent `view` rests in; Home (null) rests in the composer. */
export function mobileAssistantRest(
  view: string | null,
  options: MobileShellNavigationOptions = {},
): MobileAssistantRest {
  if (view === null) return "input";
  return options.assistantRest?.(view) ?? "pill";
}

/**
 * Back closes the drawer over Home, then lowers an open conversation one
 * detent (full to the half sheet, the sheet to the surface's rest), then
 * returns to the previous view, then to Home.
 */
export function navigateMobileShell(
  state: MobileShellNavigation,
  action: MobileShellNavigationAction,
  options: MobileShellNavigationOptions = {},
): MobileShellNavigation {
  const rest = (view: string | null) => mobileAssistantRest(view, options);
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
      const assistant = action.assistant ?? rest(action.view);
      return action.keepDrawer
        ? { ...state, view: action.view, stack, assistant }
        : {
            view: action.view,
            stack,
            drawer: false,
            drawerQuery: "",
            assistant,
          };
    }
    case "home":
      return action.assistant && action.assistant !== "input"
        ? { ...MOBILE_SHELL_HOME, assistant: action.assistant }
        : MOBILE_SHELL_HOME;
    case "back": {
      if (state.view === null && state.drawer)
        return { ...state, drawer: false, drawerQuery: "" };
      if (state.assistant === "full") return { ...state, assistant: "sheet" };
      if (state.assistant === "sheet")
        return { ...state, assistant: rest(state.view) };
      if (state.view === null) return state;
      const previous = state.stack.at(-1);
      return previous === undefined
        ? MOBILE_SHELL_HOME
        : {
            ...state,
            view: previous,
            stack: state.stack.slice(0, -1),
            assistant: rest(previous),
          };
    }
    case "drawer":
      return { ...state, drawer: action.open, drawerQuery: "" };
    case "drawer-query":
      return state.drawer ? { ...state, drawerQuery: action.query } : state;
    case "assistant":
      return {
        ...state,
        assistant: action.detent === "rest" ? rest(state.view) : action.detent,
      };
  }
}
