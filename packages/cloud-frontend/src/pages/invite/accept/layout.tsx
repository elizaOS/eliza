import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";

export default function InviteAcceptLayout() {
  return (
    <>
      <Helmet>
        <title>Accept Invitation | Eliza Cloud</title>
        <meta
          name="description"
          content="Accept your organization invitation to join an Eliza Cloud workspace and collaborate with your team."
        />
      </Helmet>
      <Outlet />
    </>
  );
}
