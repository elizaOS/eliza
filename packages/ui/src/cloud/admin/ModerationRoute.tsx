/** /dashboard/admin route — moderation panel behind the consolidated role gate. */

import { AdminGate } from "./AdminGate";
import ModerationPage from "./ModerationPage";

export default function ModerationRoute(): React.JSX.Element {
  return (
    <AdminGate>
      <ModerationPage />
    </AdminGate>
  );
}
