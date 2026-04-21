import { Application } from "@pixi/react";
import { useCallback, useRef, useState } from "react";
import type { TownState } from "../../shared/types";
import { defaultWorldMap } from "../../shared/worldMap.ts";
import { useElementSize } from "../hooks/useElementSize.ts";
import { useTownState } from "../hooks/useTownState.ts";
import PixiGame from "./PixiGame.tsx";
import PlayerDetails from "./PlayerDetails.tsx";

type GameProps = {
  onOpenSettings: () => void;
  isRunning: boolean;
  canRun: boolean;
};

export default function Game({ onOpenSettings, isRunning, canRun }: GameProps) {
  const [selectedElement, setSelectedElement] = useState<{
    kind: "player";
    id: string;
  }>();
  const [followNonce, setFollowNonce] = useState(0);
  const [gameWrapperRef, { width, height }] = useElementSize();
  const gameWrapperElement = useRef<HTMLDivElement | null>(null);
  const townState = useTownState();
  const scrollViewRef = useRef<HTMLDivElement>(null);
  const handleGameWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      gameWrapperElement.current = node;
      gameWrapperRef(node);
    },
    [gameWrapperRef],
  );
  const handleSelectElement = (element?: { kind: "player"; id: string }) => {
    setSelectedElement(element);
    setFollowNonce((prev) => prev + 1);
  };

  if (!townState) {
    return (
      <div className="w-full h-full min-h-0 min-w-0 grid grid-rows-[240px_1fr] lg:grid-rows-[1fr] lg:grid-cols-[1fr_auto]">
        <div className="relative overflow-hidden bg-brown-900 flex items-center justify-center text-brown-100">
          Loading town simulation...
        </div>
        <div className="flex flex-col overflow-y-auto shrink-0 px-4 py-6 sm:px-6 lg:w-96 xl:pr-6 border-t-8 sm:border-t-0 sm:border-l-8 border-brown-900 bg-brown-800 text-brown-100">
          Waiting for agents...
        </div>
      </div>
    );
  }

  const state: TownState = townState;
  const stageWidth = width ?? 0;
  const stageHeight = height ?? 0;
  return (
    <div className="w-full h-full min-h-0 min-w-0 grid grid-rows-[240px_1fr] lg:grid-rows-[1fr] lg:grid-cols-[1fr_auto]">
      {/* Game area */}
      <div
        className="relative overflow-hidden bg-brown-900"
        ref={handleGameWrapperRef}
      >
        <div className="absolute inset-0">
          <div className="h-full w-full">
            <Application
              width={stageWidth}
              height={stageHeight}
              backgroundColor={0x7ab5ff}
              autoStart
              resizeTo={gameWrapperElement}
              className="h-full w-full"
            >
              <PixiGame
                state={state}
                map={defaultWorldMap}
                width={stageWidth}
                height={stageHeight}
                setSelectedElement={handleSelectElement}
                selectedAgentId={selectedElement?.id}
                followNonce={followNonce}
              />
            </Application>
          </div>
        </div>
      </div>
      {/* Right column area */}
      <div
        className="flex flex-col overflow-y-auto shrink-0 px-4 py-6 sm:px-6 lg:w-96 xl:pr-6 border-t-8 sm:border-t-0 sm:border-l-8 border-brown-900  bg-brown-800 text-brown-100"
        ref={scrollViewRef}
      >
        <PlayerDetails
          state={state}
          selectedAgentId={selectedElement?.id}
          setSelectedElement={handleSelectElement}
          onOpenSettings={onOpenSettings}
          isRunning={isRunning}
          canRun={canRun}
        />
      </div>
    </div>
  );
}
