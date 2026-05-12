import type { NextPageContext } from "next";

interface ErrorProps {
  statusCode: number;
}

function ErrorPage({ statusCode }: ErrorProps) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: "4rem", margin: 0 }}>{statusCode}</h1>
      <p style={{ color: "#666" }}>
        {statusCode === 404
          ? "Page not found"
          : "An error occurred on the server"}
      </p>
      <a href="/" style={{ color: "#0070f3" }}>
        Go home
      </a>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
