/**
 * Renders the open view when its registration carries a lazy component.
 * Views a product still renders itself have no loader and render nothing
 * here. A failed load stays visible with a retry; it is never shown as empty.
 */
import {
  Component,
  type ComponentType,
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

class LoadBoundary extends Component<
  { label: string; onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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
  fallback = null,
}: {
  registry: MobileViewRegistry;
  /** Open view by any accepted name; null is Home. */
  view: string | null;
  onClose: () => void;
  fallback?: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const registration = view === null ? undefined : registry.find(view);
  if (!registration?.loader) return null;
  const View = lazyView(registration.loader, attempt);
  return (
    <LoadBoundary
      key={`${registration.id}:${attempt}`}
      label={registration.label}
      onRetry={() => setAttempt((value) => value + 1)}
    >
      <Suspense fallback={fallback}>
        <View viewId={registration.id} onClose={onClose} />
      </Suspense>
    </LoadBoundary>
  );
}
