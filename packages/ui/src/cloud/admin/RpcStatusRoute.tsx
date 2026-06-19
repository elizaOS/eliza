/** /dashboard/admin/rpc-status route — behind the consolidated role gate. */

import { AdminGate } from "./AdminGate";
import RpcStatusPage from "./RpcStatusPage";

export default function RpcStatusRoute(): React.JSX.Element {
  return (
    <AdminGate>
      <RpcStatusPage />
    </AdminGate>
  );
}
