import type { ReactNode } from "react";
import React from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
  }

  override render(): ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    const details = errorInfo?.componentStack ? `\n\nComponent stack:\n${errorInfo.componentStack}` : "";
    const msg = error.stack ?? error.message;

    return (
      <div
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
          padding: 16,
          color: "rgba(255,255,255,0.92)",
          background: "#0b0f14",
          minHeight: "100vh",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Render error</div>
        <pre style={{ whiteSpace: "pre-wrap", color: "rgba(255,255,255,0.85)" }}>
          {msg}
          {details}
        </pre>
        <div style={{ opacity: 0.8, marginTop: 10 }}>Share this error text and we’ll fix it.</div>
      </div>
    );
  }
}

