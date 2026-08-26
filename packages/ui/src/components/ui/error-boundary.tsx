/**
 * Class error boundary that catches render throws in its subtree and shows a
 * heading + retry-button fallback (overridable via `fallback`). The optional
 * `onError` hook lets a wrapper such as ViewErrorBoundary fire crash telemetry
 * without re-implementing the boundary.
 */
import * as React from "react";
import { Button } from "./button";
import { Card } from "./card";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback UI — receives the error and a reset callback */
  fallback?: (error: Error, resetErrorBoundary: () => void) => React.ReactNode;
  /** Label for the error heading (default: "Something went wrong") */
  errorLabel?: string;
  /** Label for the retry button (default: "Try Again") */
  retryLabel?: string;
  /**
   * Invoked once when a render throw is caught, with the error + React's
   * componentStack. Lets a wrapper (e.g. ViewErrorBoundary) fire crash
   * telemetry without re-implementing the boundary. Best-effort.
   */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export interface ErrorBoundaryFallbackProps {
  error: Error;
  errorLabel?: string;
  retryLabel?: string;
  onRetry: () => void;
}

/** The boundary's visible failure state, exported for deterministic visual tests. */
export function ErrorBoundaryFallback({
  error,
  errorLabel,
  retryLabel,
  onRetry,
}: ErrorBoundaryFallbackProps) {
  return (
    <Card
      surface="destructiveSubtle"
      border="destructive"
      className="flex flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm font-semibold text-destructive">
        {errorLabel ?? "Something went wrong"}
      </p>
      <p className="text-xs text-muted max-w-sm">{error.message}</p>
      <Button type="button" variant="outline" size="compact" onClick={onRetry}>
        {retryLabel ?? "Try Again"}
      </Button>
    </Card>
  );
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // error captured in state via getDerivedStateFromError; fallback UI is rendered.
    // Surface it to an optional observer (crash telemetry) without throwing.
    try {
      this.props.onError?.(error, errorInfo);
    } catch {
      // never let a telemetry hook mask the original crash
    }
  }

  resetErrorBoundary = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.resetErrorBoundary);
      }
      return (
        <ErrorBoundaryFallback
          error={this.state.error}
          errorLabel={this.props.errorLabel}
          retryLabel={this.props.retryLabel}
          onRetry={this.resetErrorBoundary}
        />
      );
    }

    return this.props.children;
  }
}
