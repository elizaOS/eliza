/** Deterministic real-component fixture for Devices & Runtimes accessibility. */
import { createRoot } from "react-dom/client";

import { DevicesRuntimesSection } from "../DevicesRuntimesSection";

const noOp = () => {};

function Fixture() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl min-w-0 p-4 text-txt">
      <DevicesRuntimesSection
        targets={[
          {
            id: "local",
            label: "This Linux device",
            detail: "This device · private local runtime",
            kind: "local",
            status: "connected",
            selected: true,
            activity: "Currently in use",
          },
          {
            id: "cloud",
            label: "Eliza Cloud",
            detail: "Managed encrypted runtime",
            kind: "cloud",
            status: "connected",
            selected: false,
            activity: "Ready",
          },
          {
            id: "relay",
            label: "Studio Mac",
            detail: "Mac · Cloud relay",
            kind: "relay",
            status: "offline",
            selected: false,
            activity: "Last seen yesterday",
            canPair: true,
            canRevoke: true,
            canRemove: true,
          },
        ]}
        pairing={{
          hostId: "linux-host",
          hostLabel: "This Linux computer",
          sessionId: "session-a11y-proof",
          code: "420731",
          expiresAt: "2099-01-01T00:05:00.000Z",
          qrPayload:
            "elizaos://remote/pair?session=session-a11y-proof&code=420731",
        }}
        linuxTarget={{
          hostId: "linux-host",
          enrolled: true,
          running: true,
          activeSessions: 1,
          lastErrorCode: null,
        }}
        onRefresh={noOp}
        onSelect={noOp}
        onRetry={noOp}
        onPair={noOp}
        onRevoke={noOp}
        onRemove={noOp}
        onInspectSsh={noOp}
        onConnectSsh={noOp}
        onActivateLinuxTarget={noOp}
        onSetLinuxTargetRunning={noOp}
        onRevokeLinuxTarget={noOp}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
