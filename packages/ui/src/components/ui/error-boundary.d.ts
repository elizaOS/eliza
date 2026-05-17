import * as React from "react";
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
export declare class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps);
  static getDerivedStateFromError(error: Error): ErrorBoundaryState;
  componentDidCatch(_error: Error, _errorInfo: React.ErrorInfo): void;
  resetErrorBoundary: () => void;
  render():
    | string
    | number
    | bigint
    | boolean
    | import("react/jsx-runtime").JSX.Element
    | Iterable<React.ReactNode>
    | Promise<
        | string
        | number
        | bigint
        | boolean
        | React.ReactPortal
        | React.ReactElement<unknown, string | React.JSXElementConstructor<any>>
        | Iterable<React.ReactNode>
        | null
        | undefined
      >
    | null
    | undefined;
}
//# sourceMappingURL=error-boundary.d.ts.map
