/**
 * Contains unexpected render failures at the page boundary so corrupt data or
 * a browser-specific fault remains an observable error instead of a blank app.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ElizaComputer] render boundary caught an error", {
      error,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error" role="alert">
          <span aria-hidden="true">!</span>
          <p className="eyebrow">Observable failure</p>
          <h1>The contribution desk could not render.</h1>
          <p>
            No empty ledger has been substituted. Reload to request the
            validated snapshot again.
          </p>
          <button onClick={() => window.location.reload()} type="button">
            Reload the page
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
