import * as React from 'react';

import type { ToastActionElement, ToastProps } from '@/components/ui/toast';

const TOAST_LIMIT = 1;
const TOAST_REMOVE_DELAY = 3000; // 3 seconds auto-dismiss

/**
 * Represents a toast object with additional properties.
 * @typedef {Object} ToasterToast
 * @property {string} id - The unique identifier of the toast.
 * @property {React.ReactNode} [title] - The title displayed in the toast.
 * @property {React.ReactNode} [description] - The description displayed in the toast.
 * @property {ToastActionElement} [action] - The action element displayed in the toast.
 */

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const;

/**
 * Variable to hold the count value.
 */
let count = 0;

/**
 * Generates a unique ID string each time it is called.
 *
 * @returns {string} The generated ID string.
 */
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

/**
 * Define a type ActionType that is based on the values of the actionTypes object.
 */
type ActionType = typeof actionTypes;

/**
 * Represents different types of actions that can be dispatched to
 * manipulate the state of a toaster toast.
 * @typedef {Object} Action
 * @property {ActionType["ADD_TOAST"]} type - The type of action to add a new toast.
 * @property {ToasterToast} toast - The toast to add.
 * @property {ActionType["UPDATE_TOAST"]} type - The type of action to update an existing toast.
 * @property {Partial<ToasterToast>} toast - The updated fields of the toast.
 * @property {ActionType["DISMISS_TOAST"]} type - The type of action to dismiss a toast.
 * @property {ToasterToast["id"]} [toastId] - The ID of the toast to dismiss.
 * @property {ActionType["REMOVE_TOAST"]} type - The type of action to remove a toast.
 * @property {ToasterToast["id"]} [toastId] - The ID of the toast to remove.
 */
type Action =
  | {
      type: ActionType['ADD_TOAST'];
      toast: ToasterToast;
    }
  | {
      type: ActionType['UPDATE_TOAST'];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType['DISMISS_TOAST'];
      toastId?: ToasterToast['id'];
    }
  | {
      type: ActionType['REMOVE_TOAST'];
      toastId?: ToasterToast['id'];
    };

/**
 * Interface representing the state object with an array of toasts.
 */
interface State {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Adds a toast to the removal queue with a specified toast ID.
 * If the toast ID already exists in the queue, it will not be added again.
 * Once the timeout period specified by TOAST_REMOVE_DELAY has elapsed, the toast will be removed from the queue.
 *
 * @param {string} toastId - The unique identifier for the toast to be added to the removal queue
 */
const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

/**
 * Reducer function to handle various actions on the state related to toasts.
 * @param {State} state - The current state of the application.
 * @param {Action} action - The action to be performed on the state.
 * @returns {State} - The updated state after performing the action.
 */
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      };

    case 'DISMISS_TOAST': {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        for (const toast of state.toasts) {
          addToRemoveQueue(toast.id);
        }
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];

/**
 * Defines a variable to store the memory state, initialized with an empty array for toasts.
 */
let memoryState: State = { toasts: [] };

/**
 * Dispatches an action by passing it to the reducer function and then
 * notifies all registered listeners with the updated memory state.
 *
 * @param {Action} action The action to dispatch
 */
function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  for (const listener of listeners) {
    listener(memoryState);
  }
}

/**
 * Represents a Toast object without the "id" property.
 */
type Toast = Omit<ToasterToast, 'id'>;

/**
 * Creates a new toast message with the given properties.
 * @param {Toast} props - The props for the toast message.
 * @returns {Object} An object containing the id of the toast, a function to dismiss the toast, and a function to update the toast.
 */
function toast({ ...props }: Toast) {
  const id = genId();

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id });

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return {
    id: id,
    dismiss,
    update,
  };
}

/**
 * Custom hook for managing toast messages.
 *
 * @returns {{
 *   showToast: Function,
 *   dismiss: Function,
 * }}
 */
function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: 'DISMISS_TOAST', toastId }),
  };
}

export { useToast, toast };
