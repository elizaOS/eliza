"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#0a0a0a",
          color: "#e5e5e5",
          fontFamily: "system-ui",
        }}
      >
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
            <button
              onClick={reset}
              style={{
                padding: "0.5rem 1rem",
                background: "#b8860b",
                border: "none",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
