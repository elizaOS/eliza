import type { Viewport } from "pixi-viewport";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TownState, WorldMapData } from "../../shared/types";
import { AgentRadius } from "./AgentRadius.tsx";
import { PixiStaticMap } from "./PixiStaticMap.tsx";
import PixiViewport from "./PixiViewport.tsx";
import { Player, type SelectElement } from "./Player.tsx";

export const PixiGame = (props: {
  state: TownState;
  map: WorldMapData;
  width: number;
  height: number;
  setSelectedElement: SelectElement;
  selectedAgentId?: string;
  followNonce?: number;
}) => {
  const viewportRef = useRef<Viewport | undefined>(undefined);
  const [isFollowing, setIsFollowing] = useState(false);

  const { width, height, tileDim } = props.map;
  const agents = useMemo(() => props.state.agents, [props.state.agents]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === props.selectedAgentId),
    [agents, props.selectedAgentId],
  );

  useEffect(() => {
    if (props.selectedAgentId) {
      setIsFollowing(true);
    }
  }, [props.selectedAgentId]);

  useEffect(() => {
    if (!selectedAgent || !viewportRef.current || !isFollowing) {
      return;
    }
    const renderPosition =
      selectedAgent.renderPosition ?? selectedAgent.position;
    const centerX = renderPosition.x * tileDim + tileDim / 2;
    const centerY = renderPosition.y * tileDim + tileDim / 2;
    viewportRef.current.moveCenter(centerX, centerY);
  }, [selectedAgent, isFollowing, tileDim]);

  return (
    <PixiViewport
      screenWidth={props.width}
      screenHeight={props.height}
      worldWidth={width * tileDim}
      worldHeight={height * tileDim}
      viewportRef={viewportRef}
      onUserInteract={() => {
        if (isFollowing) {
          setIsFollowing(false);
        }
      }}
    >
      <PixiStaticMap map={props.map} />
      {selectedAgent && <AgentRadius agent={selectedAgent} tileDim={tileDim} />}
      {agents.map((agent) => (
        <Player
          key={`player-${agent.id}`}
          agent={agent}
          tileDim={tileDim}
          onClick={props.setSelectedElement}
        />
      ))}
    </PixiViewport>
  );
};
export default PixiGame;
