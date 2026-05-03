function ErrorPage({ statusCode }: { statusCode?: number }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        color: "#e5e5e5",
        fontFamily: "system-ui",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>{statusCode || "Error"}</h1>
        <p style={{ fontSize: "0.875rem", color: "#888" }}>
          {statusCode === 404 ? "Page not found" : "An error occurred"}
        </p>
      </div>
    </div>
  );
}

ErrorPage.getInitialProps = ({
  res,
  err,
}: {
  res?: { statusCode: number };
  err?: { statusCode: number };
}) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode : 404;
  return { statusCode };
};

export default ErrorPage;
