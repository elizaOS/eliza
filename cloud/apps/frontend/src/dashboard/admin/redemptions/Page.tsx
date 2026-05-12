import { Helmet } from "react-helmet-async";
import { AdminRedemptionsWrapper } from "../_components/redemptions-wrapper";

/** /dashboard/admin/redemptions — review and approve token redemption requests. */
export default function AdminRedemptionsPage() {
  return (
    <>
      <Helmet>
        <title>Admin: Redemption Management</title>
        <meta name="description" content="Review and approve token redemption requests" />
      </Helmet>
      <AdminRedemptionsWrapper />
    </>
  );
}
