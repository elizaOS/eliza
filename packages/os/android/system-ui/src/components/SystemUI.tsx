import type { ReactNode } from "react";
import { NavigationButtons, type NavigationButtonsProps } from "./NavigationButtons";
import { StatusBar } from "./StatusBar";

export interface SystemUIProps {
  children?: ReactNode;
  navigation?: NavigationButtonsProps;
  showNavigation?: boolean;
}

export function SystemUI({
  children,
  navigation,
  showNavigation = true,
}: SystemUIProps) {
  return (
    <div
      className="elizaos-mobile-systemui"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <StatusBar />
      <main className="elizaos-mobile-content" style={{ flex: 1, position: "relative" }}>
        {children}
      </main>
      {showNavigation ? <NavigationButtons {...(navigation ?? {})} /> : null}
    </div>
  );
}
