/**
 * Renders the open view when its registration carries a lazy component.
 * Views a product still renders itself have no loader and render nothing
 * here. A failed load, or a view that throws while rendering, stays visible
 * with a retry; it is never shown as empty, and the error reaches `onError`.
 */
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import type {
  MobileViewLoader,
  MobileViewProps,
  MobileViewRegistry,
} from "./view-registry";

type LazyView = LazyExoticComponent<ComponentType<MobileViewProps>>;
const loaded = new WeakMap<
  MobileViewLoader,
  { attempt: number; view: LazyView }
>();

/** One lazy component per loader and retry attempt, so a retry loads again. */
function lazyView(loader: MobileViewLoader, attempt: number): LazyView {
  const known = loaded.get(loader);
  if (known && known.attempt >= attempt) return known.view;
  const view = lazy(loader);
  loaded.set(loader, { attempt, view });
  return view;
}

export type MobileViewError = (
  error: unknown,
  context: { viewId: string; componentStack?: string | null },
) => void;

class LoadBoundary extends Component<
  {
    label: string;
    viewId: string;
    onRetry: () => void;
    onError?: MobileViewError;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.(error, {
      viewId: this.props.viewId,
      componentStack: info.componentStack,
    });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-mobile-shell-view-error="" role="alert">
        <p>{this.props.label} could not be opened.</p>
        <button
          type="button"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onRetry();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}

export function MobileViewHost({
  registry,
  view,
  onClose,
  onError,
  fallback = null,
}: {
  registry: MobileViewRegistry;
  /** Open view by any accepted name; null is Home. */
  view: string | null;
  onClose: () => void;
  fallback?: ReactNode;
  /** Receives each load or render failure of the open view, for reporting. */
  onError?: MobileViewError;
}) {
  // Retries are counted per view, so retrying one view never reloads another.
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const registration = view === null ? undefined : registry.find(view);
  if (!registration?.loader) return null;
  const { id } = registration;
  const attempt = attempts[id] ?? 0;
  const View = lazyView(registration.loader, attempt);
  return (
    <LoadBoundary
      key={`${id}:${attempt}`}
      label={registration.label}
      viewId={id}
      onError={onError}
      onRetry={() =>
        setAttempts((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
      }
    >
      <Suspense fallback={fallback}>
        <View viewId={registration.id} onClose={onClose} />
      </Suspense>
    </LoadBoundary>
  );
}
