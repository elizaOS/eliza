import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";

export default function LoginLayout() {
  return (
    <>
      <Helmet>
        <title>Login | Eliza Cloud</title>
        <meta
          name="description"
          content="Sign in to chat with your Eliza cloud agent and manage your account."
        />
        <meta name="robots" content="noindex" />
      </Helmet>
      <Outlet />
    </>
  );
}
