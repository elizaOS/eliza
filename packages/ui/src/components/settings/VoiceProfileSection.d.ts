/**
 * VoiceProfileSection — voice-profile manager settings panel (R10 §5).
 *
 * Lists known voice profiles (OWNER pinned at top) with rename / set
 * relationship / merge / split / delete affordances. Server data comes
 * from `VoiceProfilesClient` (R10 §5.3 adapter) — when I2 hasn't landed
 * the endpoints yet the adapter returns `[]` and we render the empty
 * state instead of crashing.
 */
import * as React from "react";
import type {
  VoiceProfile,
  VoiceProfilesClient,
} from "../../api/client-voice-profiles";
export interface VoiceProfileSectionProps {
  /**
   * Adapter (R10 §5.3). Must be supplied by the parent that holds the
   * `ElizaClient`.  In tests the caller can pass a fake adapter.
   */
  profilesClient: VoiceProfilesClient;
  /** Pre-loaded profiles (skips initial fetch — useful for tests). */
  initialProfiles?: VoiceProfile[];
  /** Render the panel inside a settings card chrome (default true). */
  framed?: boolean;
  className?: string;
}
export declare function VoiceProfileSection({
  profilesClient,
  initialProfiles,
  framed,
  className,
}: VoiceProfileSectionProps): React.ReactElement;
export default VoiceProfileSection;
//# sourceMappingURL=VoiceProfileSection.d.ts.map
