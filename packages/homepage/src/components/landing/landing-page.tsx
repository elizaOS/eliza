
/**
 * Composed landing page for unauthenticated users.
 * Renders background, header, hero chat input, and footer.
 */


import { LandingBackground } from "./landing-background";
import { LandingHeader } from "./landing-header";
import { HeroChatInput } from "./hero-chat-input";
import { LandingFooter } from "./footer";

export function LandingPage() {

  return (
    <div className="relative flex h-screen bg-black">
      <LandingBackground />

      <div className="relative z-30 flex w-full flex-col overflow-y-scroll landing-scroll min-h-screen">
        <LandingHeader />

        <div className="min-h-screen flex items-center justify-center pb-12 sm:pb-32 flex-1">
          <HeroChatInput />
        </div>

        <LandingFooter />
      </div>
    </div>
  );
}
