import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";

export default function LoginLayout() {
  return (
    <>
      <Helmet>
        <title>Login | Eliza Cloud</title>
        <meta
          name="description"
          content="Sign in to Eliza Cloud to create, provision, and manage Eliza agents."
        />
        <meta name="robots" content="noindex" />
      </Helmet>
      <Outlet />
    </>
  );
}
