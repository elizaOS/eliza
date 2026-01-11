import type { NextPageContext } from "next";

interface ErrorProps {
  statusCode: number;
}

function Error({ statusCode }: ErrorProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
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

Error.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default Error;



