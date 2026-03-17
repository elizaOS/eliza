import { ErrorBoundary as UiErrorBoundary } from "@elizaos/ui";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

/**
 * Catches React render errors and shows a recovery UI instead of a white screen.
 * Wrap route content or the entire app shell with this boundary.
 */
export class ErrorBoundary extends Component<Props> {
  private renderFallback = (
    error: Error,
    resetErrorBoundary: () => void,
  ): ReactNode => {
    const handleReload = () => {
      resetErrorBoundary();
      window.location.reload();
    };

    return (
      <div className="flex h-full min-h-[200px] w-full items-center justify-center bg-bg text-txt">
        <div className="max-w-md p-8 text-center">
          <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
          <p className="mb-1 text-sm text-muted">
            An unexpected error occurred.
          </p>
          <p className="mb-4 break-all rounded bg-card px-3 py-2 font-mono text-xs text-muted">
            {error.message}
          </p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={resetErrorBoundary}
              className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-card"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={handleReload}
              className="cursor-pointer rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
            >
              Reload Page
            </button>
          </div>
        </div>
      </div>
    );
  };

  render() {
    return (
      <UiErrorBoundary fallback={this.renderFallback}>
        {this.props.children}
      </UiErrorBoundary>
    );
  }
}
