"use client";

import { logger } from "@feed/shared";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for panel content.
 * Catches rendering errors and displays a fallback UI instead of crashing.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    Sentry.withScope((scope) => {
      scope.setTag("errorBoundary", "panel");
      scope.setTag("surface", "agent-team-panel");
      scope.setContext("panelErrorBoundary", {
        componentStack: errorInfo.componentStack,
      });
      Sentry.captureException(error);
    });

    if (process.env.NODE_ENV !== "production") {
      logger.error(
        "Panel rendering error",
        { message: error.message, componentStack: errorInfo.componentStack },
        "PanelErrorBoundary",
      );
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <div className="space-y-1">
            <p className="font-medium text-foreground text-sm">
              Unable to display panel
            </p>
            <p className="text-muted-foreground text-xs">
              {this.state.error?.message ||
                "An error occurred while rendering this content."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 rounded-md bg-muted px-3 py-1.5 text-foreground text-xs transition-colors hover:bg-muted/80"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
