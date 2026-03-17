import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches React render errors and shows a recovery UI instead of a white screen.
 * Wrap route content or the entire app shell with this boundary.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full w-full min-h-[200px] bg-bg text-txt">
          <div className="text-center max-w-md p-8">
            <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
            <p className="text-sm text-muted mb-1">
              An unexpected error occurred.
            </p>
            {this.state.error && (
              <p className="text-xs text-muted font-mono bg-card rounded px-3 py-2 mb-4 break-all">
                {this.state.error.message}
              </p>
            )}
            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={this.handleDismiss}
                className="px-4 py-2 text-sm font-medium border border-border rounded-md hover:bg-card cursor-pointer"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="px-4 py-2 text-sm font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 cursor-pointer"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
