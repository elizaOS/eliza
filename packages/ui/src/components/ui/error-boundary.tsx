import * as React from "react";
import { Button } from "./button";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback UI — receives the error and a reset callback */
  fallback?: (error: Error, resetErrorBoundary: () => void) => React.ReactNode;
  /** Label for the error heading (default: "Something went wrong") */
  errorLabel?: string;
  /** Label for the retry button (default: "Try Again") */
  retryLabel?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
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
    console.error("[ErrorBoundary]", error, errorInfo);
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
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center border border-destructive/30 bg-destructive/5 rounded-md">
          <p className="text-sm font-semibold text-destructive">
            {this.props.errorLabel ?? "Something went wrong"}
          </p>
          <p className="text-xs text-muted max-w-sm">
            {this.state.error.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md text-xs"
            onClick={this.resetErrorBoundary}
          >
            {this.props.retryLabel ?? "Try Again"}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
