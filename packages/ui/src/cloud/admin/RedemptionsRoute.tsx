/** /dashboard/admin/redemptions route — behind the consolidated role gate. */

import { AdminGate } from "./AdminGate";
import RedemptionsPage from "./RedemptionsPage";

export default function RedemptionsRoute(): React.JSX.Element {
  return (
    <AdminGate>
      <RedemptionsPage />
    </AdminGate>
  );
}
