/**
 * Standalone preview entry mounting the PermissionRecoveryCallout for visual review.
 */
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import { PermissionRecoveryCallout } from "@ui-src/components/permissions/PermissionRecoveryCallout.tsx";
import "./permission-preview.css";

const noop = (): void => undefined;

function PermissionPreview() {
  return (
    <main className="permission-preview-page">
      <section className="permission-preview-shell">
        <div>
          <h1 className="permission-preview-heading">Permission recovery</h1>
          <p className="permission-preview-copy">
            Failure states use one reusable callout with a direct settings path
            and a retry action.
          </p>
        </div>
        <div className="permission-preview-grid">
          <PermissionRecoveryCallout
            permission="camera"
            title="Camera access is off"
            description="Enable camera access for Eliza, then return here to start the preview."
            onRetry={noop}
            testId="preview-camera-permission-callout"
          />
          <PermissionRecoveryCallout
            permission="messages"
            title="SMS access is off"
            description="Eliza needs SMS permission before it can read threads or send a message from this device."
            onRetry={noop}
            testId="preview-messages-permission-callout"
          />
          <div className="permission-preview-wide">
            <PermissionRecoveryCallout
              permission="usage-access"
              title="Usage access is off"
              description="Open Android Usage Access, choose Eliza, and turn on Permit usage access to let app-blocking and focus checks work."
              settingsLabel="Open Usage Access"
              onRetry={noop}
              testId="preview-usage-permission-callout"
            />
          </div>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(<PermissionPreview />);
